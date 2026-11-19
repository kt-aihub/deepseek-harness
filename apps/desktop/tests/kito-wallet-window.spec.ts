import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  const jar: Array<{ name: string; value: string; path?: string | undefined }> = []
  const cookiesGet = vi.fn(async (filter?: { name?: string }) => (
    filter?.name ? jar.filter(cookie => cookie.name === filter.name) : [...jar]
  ))
  const cookiesSet = vi.fn(async (cookie: { name: string; value: string; path?: string | undefined }) => {
    const idx = jar.findIndex(item => item.name === cookie.name && item.path === cookie.path)
    if (idx >= 0) jar[idx] = { name: cookie.name, value: cookie.value, path: cookie.path }
    else jar.push({ name: cookie.name, value: cookie.value, path: cookie.path })
  })
  const cookiesRemove = vi.fn(async (_url: string, name: string) => {
    for (let i = jar.length - 1; i >= 0; i -= 1) {
      if (jar[i]?.name === name) jar.splice(i, 1)
    }
  })
  const clearStorageData = vi.fn(async () => undefined)
  return {
    jar,
    cookiesGet,
    cookiesSet,
    cookiesRemove,
    clearStorageData,
    BrowserWindow: vi.fn(),
    session: {
      fromPartition: () => ({
        cookies: {
          get: cookiesGet,
          set: cookiesSet,
          remove: cookiesRemove,
        },
        clearStorageData,
      }),
    },
  }
})

vi.mock('electron', () => electronMock)

import { KitoConsoleSessionError, openKitoConsole, readKitoAccountBalance, signOutKitoConsole } from '../src/kito-wallet-window.ts'
import { writeKitoConsoleAccountNo } from '../src/kito-wallet.ts'

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kito-console-'))
  vi.stubEnv('KITO_HARNESS_HOME', home)
})

afterEach(async () => {
  electronMock.jar.length = 0
  electronMock.cookiesGet.mockClear()
  electronMock.cookiesSet.mockClear()
  electronMock.cookiesRemove.mockClear()
  electronMock.clearStorageData.mockClear()
  await signOutKitoConsole({ fetchImpl: async () => new Response(null, { status: 200 }) })
  electronMock.clearStorageData.mockClear()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function accountResponse(accountNo: string): Response {
  return new Response(JSON.stringify({ account: { displayName: 'Person', accountNo } }), { status: 200 })
}

function sessionCookie(): Response {
  const headers = new Headers()
  headers.append('set-cookie', 'new_api_refresh=sid.next; Path=/api/user/auth; HttpOnly; SameSite=Strict')
  return new Response(JSON.stringify({ success: true }), { status: 200, headers })
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

describe('readKitoAccountBalance', () => {
  it('reads spendable balance from /api/usage/account/ without creating a console session', async () => {
    const seenUrls: string[] = []
    const balance = await readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-managed',
      fetchImpl: async (url, init) => {
        seenUrls.push(urlOf(url))
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-managed')
        return new Response(JSON.stringify({
          success: true,
          data: { object: 'account_usage', quota_per_unit: 500_000, remain_quota: 227_350_659, remaining_usd: 454.701318 },
        }), { status: 200 })
      },
    })
    expect(balance).toBe(454.7)
    expect(seenUrls).toEqual(['https://ktapi.example/api/usage/account/'])
    expect(electronMock.cookiesSet).not.toHaveBeenCalled()
  })

  it('derives or refreshes the API key once when missing or rejected with 401', async () => {
    let calls = 0
    const refreshed = vi.fn(async () => 'sk-fresh')
    const balance = await readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-stale',
      refreshApiKey: refreshed,
      fetchImpl: async (_url, init) => {
        calls += 1
        const auth = new Headers(init?.headers).get('authorization')
        if (auth === 'Bearer sk-stale') return new Response(null, { status: 401 })
        return new Response(JSON.stringify({ data: { remaining_usd: 12.34 } }), { status: 200 })
      },
    })
    expect(calls).toBe(2)
    expect(refreshed).toHaveBeenCalledWith('id-token')
    expect(balance).toBe(12.34)
  })

  it('derives the API key on first read when none is stored locally yet', async () => {
    const refreshed = vi.fn(async () => 'sk-derived')
    const balance = await readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => undefined,
      refreshApiKey: refreshed,
      fetchImpl: async () => new Response(JSON.stringify({ data: { remain_quota: 1_000_000, quota_per_unit: 500_000 } }), { status: 200 }),
    })
    expect(refreshed).toHaveBeenCalledWith('id-token')
    expect(balance).toBe(2)
  })

  it('backs off on 429 and falls back only to an existing console cookie when /api/usage/account/ is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    const missing = await readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-managed',
      fetchImpl: fetchMock,
    })
    expect(missing).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const limitedFetch = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }))
    const throttled = await readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-managed',
      fetchImpl: limitedFetch,
    })
    expect(throttled).toBeUndefined()
    // Subsequent call within cooldown does not hit the network again.
    await expect(readKitoAccountBalance('id-token', {
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-managed',
      fetchImpl: limitedFetch,
    })).resolves.toBeUndefined()
    expect(limitedFetch).toHaveBeenCalledTimes(1)
  })

  it('isolates cached balance and rate-limit cooldowns across accounts', async () => {
    const first = await readKitoAccountBalance('baojun-token', {
      accountNo: 'KT-BAOJUN',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-baojun',
      fetchImpl: async () => new Response(JSON.stringify({ data: { remaining_usd: 416.92 } }), { status: 200 }),
    })
    expect(first).toBe(416.92)

    // Switching to another account within BALANCE_TTL_MS must never return the previous account's cached balance.
    const second = await readKitoAccountBalance('mango-token', {
      accountNo: 'KT-MANGO',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-mango',
      fetchImpl: async () => new Response(JSON.stringify({ data: { remaining_usd: 4813.3 } }), { status: 200 }),
    })
    expect(second).toBe(4813.3)

    // Rate limiting one account must not leak its balance or block a different account.
    await expect(readKitoAccountBalance('third-token', {
      accountNo: 'KT-THIRD',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-third',
      fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
    })).resolves.toBeUndefined()
    await expect(readKitoAccountBalance('fourth-token', {
      accountNo: 'KT-FOURTH',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-fourth',
      fetchImpl: async () => new Response(JSON.stringify({ data: { remaining_usd: 99.5 } }), { status: 200 }),
    })).resolves.toBe(99.5)
  })

  it('skips the console-cookie balance fallback when the cookie belongs to another account or has no owner', async () => {
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.baojun', path: '/api/user/auth' })
    const unownedCalls: string[] = []
    await expect(readKitoAccountBalance('mango-token', {
      accountNo: 'KT-MANGO',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-mango',
      fetchImpl: async (url) => {
        unownedCalls.push(urlOf(url))
        return new Response(null, { status: 404 })
      },
    })).resolves.toBeUndefined()
    expect(unownedCalls).toEqual(['https://ktapi.example/api/usage/account/'])

    await writeKitoConsoleAccountNo('KT-BAOJUN', home)
    const otherCalls: string[] = []
    await expect(readKitoAccountBalance('mango-token', {
      accountNo: 'KT-MANGO',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-mango',
      fetchImpl: async (url) => {
        otherCalls.push(urlOf(url))
        return new Response(null, { status: 404 })
      },
    })).resolves.toBeUndefined()
    expect(otherCalls).toEqual(['https://ktapi.example/api/usage/account/'])
  })

  it('uses the console-cookie balance fallback only when the cookie belongs to the same account', async () => {
    await writeKitoConsoleAccountNo('KT-MANGO', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.mango', path: '/api/user/auth' })
    const calls: string[] = []
    const balance = await readKitoAccountBalance('mango-token', {
      accountNo: 'KT-MANGO',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-mango',
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        if (urlOf(url).endsWith('/api/usage/account/')) return new Response(null, { status: 404 })
        if (urlOf(url).endsWith('/api/user/auth/refresh')) {
          const headers = new Headers()
          headers.append('set-cookie', 'new_api_refresh=sid.mango.rotated; Path=/api/user/auth; HttpOnly; SameSite=Strict')
          return new Response(JSON.stringify({ data: { user: { quota: 2_500_000 } } }), { status: 200, headers })
        }
        return new Response(null, { status: 500 })
      },
    })
    expect(balance).toBe(5)
    expect(calls).toEqual([
      'https://ktapi.example/api/usage/account/',
      'https://www.ktapi.cc/api/user/auth/refresh',
    ])
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.mango.rotated')).toBe(true)
  })

  it('does not fall back to the console refresh endpoint after /api/usage/account/ returns 429', async () => {
    await writeKitoConsoleAccountNo('KT-MANGO', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.mango', path: '/api/user/auth' })
    const calls: string[] = []
    await expect(readKitoAccountBalance('mango-token', {
      accountNo: 'KT-MANGO',
      baseUrl: 'https://ktapi.example',
      readApiKey: async () => 'sk-mango',
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        return new Response(null, { status: 429, headers: { 'retry-after': '120' } })
      },
    })).resolves.toBeUndefined()
    expect(calls).toEqual(['https://ktapi.example/api/usage/account/'])
  })
})

describe('openKitoConsole', () => {
  const makeFakeWindow = () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    const webHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
    let currentUrl = 'about:blank'
    const fake = {
      destroyed: false,
      loaded: [] as string[],
      closed: false,
      setTitle: vi.fn(),
      isDestroyed: () => fake.destroyed,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      close: () => {
        fake.closed = true
        fake.destroyed = true
        for (const fn of handlers.get('closed') ?? []) fn()
      },
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
      },
      loadURL: vi.fn(async (url: string) => {
        fake.loaded.push(url)
        currentUrl = url
      }),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        getURL: () => currentUrl,
        on: (ev: string, fn: (...args: unknown[]) => void) => {
          webHandlers.set(ev, [...(webHandlers.get(ev) ?? []), fn])
        },
        emitNavigate: (ev: string, url: string) => {
          currentUrl = url
          for (const fn of webHandlers.get(ev) ?? []) fn({}, url)
        },
      },
    }
    return fake
  }

  it('throws KitoConsoleSessionError on 409 without opening an unauthenticated login window', async () => {
    const createWindow = vi.fn()
    await expect(openKitoConsole('id-token', 'wallet', {
      deviceId: 'dev-1',
      createWindow,
      fetchImpl: async () => new Response(JSON.stringify({ code: 'AUTH_SESSION_LIMIT', message: 'Conflict' }), { status: 409 }),
    })).rejects.toMatchObject({ name: 'KitoConsoleSessionError', kind: 'session-limit', status: 409 })
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('preserves stored refresh cookie on transient refresh error when ownership is confirmed', async () => {
    await writeKitoConsoleAccountNo('KT-MANGO', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.secret', path: '/api/user/auth' })
    const fake = makeFakeWindow()
    const calls: string[] = []
    await openKitoConsole('id-token', 'usage', {
      deviceId: 'dev-1',
      createWindow: () => fake as never,
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-MANGO')
        return new Response(null, { status: 503 })
      },
    })
    expect(calls).toEqual([
      'https://login.ktyun.cc/identity/v1/account/me',
      'https://www.ktapi.cc/api/user/auth/refresh',
    ])
    expect(electronMock.cookiesRemove).not.toHaveBeenCalled()
    expect(fake.loaded).toEqual(['https://www.ktapi.cc/usage-logs/common'])
  })

  it('refuses to open an unverified stored cookie when Identity profile lookup fails, while preserving the cookie', async () => {
    await writeKitoConsoleAccountNo('KT-BAOJUN', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.baojun', path: '/api/user/auth' })
    const createWindow = vi.fn()
    await expect(openKitoConsole('mango-token', 'wallet', {
      deviceId: 'dev-profile-down',
      createWindow,
      fetchImpl: async () => new Response(null, { status: 503 }),
    })).rejects.toMatchObject({ name: 'KitoConsoleSessionError', kind: 'unavailable', status: 503 })
    expect(createWindow).not.toHaveBeenCalled()
    expect(electronMock.cookiesRemove).not.toHaveBeenCalled()
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.baojun')).toBe(true)

    await expect(openKitoConsole('expired-token', 'wallet', {
      deviceId: 'dev-profile-401',
      createWindow,
      fetchImpl: async () => new Response(null, { status: 401 }),
    })).rejects.toMatchObject({ name: 'KitoConsoleSessionError', kind: 'identity-rejected', status: 401 })
    expect(createWindow).not.toHaveBeenCalled()
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.baojun')).toBe(true)
  })

  it('coalesces concurrent open calls onto a single ensure and single window', async () => {
    const fake = makeFakeWindow()
    let ensureCalls = 0
    let releaseEnsure!: () => void
    const gate = new Promise<void>((resolve) => { releaseEnsure = resolve })
    const fetchImpl: typeof fetch = async (url, init) => {
      if (urlOf(url).endsWith('/api/iam/ensure')) {
        ensureCalls += 1
        expect(new Headers(init?.headers).get('x-kito-device-id')).toBe('dev-serial')
        await gate
        const headers = new Headers()
        headers.append('set-cookie', 'new_api_refresh=sid.one; Path=/api/user/auth; HttpOnly; SameSite=Strict')
        headers.append('set-cookie', 'new_api_has_session=1; Path=/; SameSite=Strict')
        return new Response(JSON.stringify({ success: true }), { status: 200, headers })
      }
      return new Response(null, { status: 500 })
    }

    const first = openKitoConsole('id-token', 'wallet', {
      deviceId: 'dev-serial',
      createWindow: () => fake as never,
      fetchImpl,
    })
    const second = openKitoConsole('id-token', 'usage', {
      deviceId: 'dev-serial',
      createWindow: () => fake as never,
      fetchImpl,
    })
    releaseEnsure()
    await Promise.all([first, second])
    expect(ensureCalls).toBe(1)
    expect(fake.loaded).toEqual(['https://www.ktapi.cc/wallet', 'https://www.ktapi.cc/usage-logs/common'])
  })

  it('recovers once when the SPA redirects client-side to /sign-in?redirect=...', async () => {
    await writeKitoConsoleAccountNo('KT-SPA', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.stale', path: '/api/user/auth' })
    const fake = makeFakeWindow()
    let ensureCalls = 0
    await openKitoConsole('id-token', 'wallet', {
      deviceId: 'dev-spa',
      createWindow: () => fake as never,
      fetchImpl: async (url) => {
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-SPA')
        if (urlOf(url).endsWith('/api/user/auth/refresh')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        if (urlOf(url).endsWith('/api/iam/ensure')) {
          ensureCalls += 1
          const headers = new Headers()
          headers.append('set-cookie', 'new_api_refresh=sid.fresh; Path=/api/user/auth; HttpOnly; SameSite=Strict')
          return new Response(JSON.stringify({ success: true }), { status: 200, headers })
        }
        return new Response(null, { status: 500 })
      },
    })
    fake.webContents.emitNavigate('did-navigate-in-page', 'https://www.ktapi.cc/sign-in?redirect=%2Fwallet')
    await vi.waitFor(() => { expect(ensureCalls).toBe(1) })
    await vi.waitFor(() => { expect(fake.loaded).toEqual(['https://www.ktapi.cc/wallet', 'https://www.ktapi.cc/wallet']) })
    expect(electronMock.cookiesRemove).toHaveBeenCalled()
    expect(KitoConsoleSessionError).toBeDefined()
  })

  it('replaces a console cookie that was stored before any account was remembered', async () => {
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.old', path: '/api/user/auth' })
    const fake = makeFakeWindow()
    const calls: string[] = []
    await openKitoConsole('mango-token', 'wallet', {
      deviceId: 'dev-unrecorded',
      createWindow: () => fake as never,
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-MANGO')
        if (urlOf(url).endsWith('/api/user/auth/logout')) return new Response(null, { status: 200 })
        if (urlOf(url).endsWith('/api/iam/ensure')) return sessionCookie()
        return new Response(null, { status: 500 })
      },
    })
    expect(calls.some(url => url.endsWith('/api/user/auth/refresh'))).toBe(false)
    expect(calls.some(url => url.endsWith('/api/iam/ensure'))).toBe(true)
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.old')).toBe(false)
  })

  it('replaces a console cookie left by another KT account', async () => {
    await writeKitoConsoleAccountNo('KT-BAOJUN', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.baojun', path: '/api/user/auth' })
    const fake = makeFakeWindow()
    const calls: string[] = []
    await openKitoConsole('mango-token', 'wallet', {
      deviceId: 'dev-switch',
      createWindow: () => fake as never,
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-MANGO')
        if (urlOf(url).endsWith('/api/user/auth/logout')) return new Response(null, { status: 200 })
        if (urlOf(url).endsWith('/api/iam/ensure')) return sessionCookie()
        return new Response(null, { status: 500 })
      },
    })
    expect(calls.some(url => url.endsWith('/api/user/auth/refresh'))).toBe(false)
    expect(calls.some(url => url.endsWith('/api/iam/ensure'))).toBe(true)
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.baojun')).toBe(false)
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.next')).toBe(true)
    expect(fake.loaded).toEqual(['https://www.ktapi.cc/wallet'])
  })

  it('keeps the console cookie when Identity names the same account', async () => {
    await writeKitoConsoleAccountNo('KT-MANGO', home)
    electronMock.jar.push({ name: 'new_api_refresh', value: 'sid.mango', path: '/api/user/auth' })
    const fake = makeFakeWindow()
    const calls: string[] = []
    await openKitoConsole('mango-token', 'wallet', {
      deviceId: 'dev-same',
      createWindow: () => fake as never,
      fetchImpl: async (url) => {
        calls.push(urlOf(url))
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-MANGO')
        if (urlOf(url).endsWith('/api/user/auth/refresh')) return new Response(JSON.stringify({ success: true }), { status: 200 })
        return new Response(null, { status: 500 })
      },
    })
    expect(calls).toEqual([
      'https://login.ktyun.cc/identity/v1/account/me',
      'https://www.ktapi.cc/api/user/auth/refresh',
    ])
    expect(electronMock.jar.some(cookie => cookie.value === 'sid.mango')).toBe(true)
    expect(fake.loaded).toEqual(['https://www.ktapi.cc/wallet'])
  })

  it('closes an already-open wallet window and clears site storage when switching to another KT account', async () => {
    const firstWindow = makeFakeWindow()
    const secondWindow = makeFakeWindow()
    const createWindow = vi.fn()
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow)

    await openKitoConsole('baojun-token', 'wallet', {
      deviceId: 'dev-open-switch',
      createWindow,
      fetchImpl: async (url) => {
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-BAOJUN')
        if (urlOf(url).endsWith('/api/iam/ensure')) {
          const headers = new Headers()
          headers.append('set-cookie', 'new_api_refresh=sid.baojun; Path=/api/user/auth; HttpOnly; SameSite=Strict')
          return new Response(JSON.stringify({ success: true }), { status: 200, headers })
        }
        return new Response(null, { status: 500 })
      },
    })
    expect(firstWindow.closed).toBe(false)

    await openKitoConsole('mango-token', 'wallet', {
      deviceId: 'dev-open-switch',
      createWindow,
      fetchImpl: async (url) => {
        if (urlOf(url).endsWith('/identity/v1/account/me')) return accountResponse('KT-MANGO')
        if (urlOf(url).endsWith('/api/user/auth/logout')) return new Response(null, { status: 200 })
        if (urlOf(url).endsWith('/api/iam/ensure')) return sessionCookie()
        return new Response(null, { status: 500 })
      },
    })
    expect(firstWindow.closed).toBe(true)
    expect(secondWindow.loaded).toEqual(['https://www.ktapi.cc/wallet'])
    expect(electronMock.clearStorageData).toHaveBeenCalledWith({
      origin: 'https://www.ktapi.cc',
      storages: ['localstorage', 'indexdb', 'cachestorage'],
    })
  })
})
