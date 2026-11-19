/**
 * Commit a newly authenticated KT Identity login without carrying over the previous account's
 * console session, refresh token, balance cache, or derived relay key.
 */

import { failureDetail } from './kito-http.ts'

/** Storage and cleanup seams used when committing a new Kito sign-in. */
export interface KitoIdentityCommitDeps {
  /** Persist `KITO_IDENTITY_TOKEN`. */
  readonly saveIdentityToken: (token: string) => Promise<{ ok: boolean }>
  /** Revoke and clear the stored ktapi.cc console session, balance cache, and open wallet window. */
  readonly signOutConsole: () => Promise<void>
  /** Remove stale refresh token and derived model keys from any previous account before deriving anew. */
  readonly clearPreviousCredentials: () => Promise<void>
  /** Derive and persist the new account's managed NewAPI relay key. */
  readonly deriveModelKey: (token: string) => Promise<string | undefined>
}

/**
 * Store a newly signed-in KT Identity token and isolate it from any previous account.
 *
 * Removing the previous refresh token, model keys, and console session before deriving the
 * replacement relay key guarantees that a switch without explicit sign-out can never bill the
 * previous account's key, show the previous account's balance, or open the previous wallet.
 * @param identityToken - freshly exchanged KT Identity access token.
 * @param deps - credential store, console cleanup, and model-key derivation seams.
 * @returns whether the Identity token itself was persisted.
 */
export async function commitKitoIdentity(
  identityToken: string,
  deps: KitoIdentityCommitDeps,
): Promise<{ ok: boolean }> {
  const saved = await deps.saveIdentityToken(identityToken)
  if (!saved.ok) return saved
  await Promise.all([
    deps.signOutConsole().catch((error: unknown) => {
      console.error('kito sign-in console cleanup failed', failureDetail(error))
    }),
    deps.clearPreviousCredentials().catch((error: unknown) => {
      console.error('kito sign-in credential cleanup failed', failureDetail(error))
    }),
  ])
  await deps.deriveModelKey(identityToken).catch((error: unknown) => {
    console.error('kito sign-in model key derivation failed', failureDetail(error))
  })
  return saved
}
