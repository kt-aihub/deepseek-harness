import { describe, expect, it, vi } from 'vitest'
import { commitKitoIdentity } from '../src/kito-account-switch.ts'

describe('commitKitoIdentity', () => {
  it('leaves existing account state untouched when storing the new Identity token fails', async () => {
    const signOutConsole = vi.fn(async () => undefined)
    const clearPreviousCredentials = vi.fn(async () => undefined)
    const deriveModelKey = vi.fn(async () => 'sk-new')

    const result = await commitKitoIdentity('next-token', {
      saveIdentityToken: async () => ({ ok: false }),
      signOutConsole,
      clearPreviousCredentials,
      deriveModelKey,
    })

    expect(result).toEqual({ ok: false })
    expect(signOutConsole).not.toHaveBeenCalled()
    expect(clearPreviousCredentials).not.toHaveBeenCalled()
    expect(deriveModelKey).not.toHaveBeenCalled()
  })

  it('clears the previous console session and credentials before deriving the new model key', async () => {
    const events: string[] = []

    const result = await commitKitoIdentity('mango-token', {
      saveIdentityToken: async (token) => {
        events.push(`save:${token}`)
        return { ok: true }
      },
      signOutConsole: async () => {
        events.push('sign-out-console')
      },
      clearPreviousCredentials: async () => {
        events.push('clear-previous-credentials')
      },
      deriveModelKey: async (token) => {
        events.push(`derive:${token}`)
        return 'sk-mango'
      },
    })

    expect(result).toEqual({ ok: true })
    expect(events[0]).toBe('save:mango-token')
    expect(events.slice(1, 3).sort()).toEqual(['clear-previous-credentials', 'sign-out-console'])
    expect(events[3]).toBe('derive:mango-token')
  })

  it('keeps the committed sign-in successful when cleanup or model-key derivation fails transiently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = await commitKitoIdentity('mango-token', {
        saveIdentityToken: async () => ({ ok: true }),
        signOutConsole: async () => { throw new Error('logout offline') },
        clearPreviousCredentials: async () => { throw new Error('unset unavailable') },
        deriveModelKey: async () => { throw new Error('ktapi 503') },
      })
      expect(result).toEqual({ ok: true })
      expect(errorSpy).toHaveBeenCalledTimes(3)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
