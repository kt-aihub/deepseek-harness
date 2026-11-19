# ADR 0006: Kito Harness Enterprise Versioning Governance and Core Observability

English | [中文](0006-kito-versioning-governance-and-core-observability.zh.md)

Date: 2026-11-19

Status: Accepted (extends and amends `ADR 0005`)

## Context

`ADR 0005` established two separate version lines: every `package.json` tracks the merged upstream `dsh` release version, while `kt/kito-harness/version.json` holds the Kito Harness product version and planned to move to `1.0.0-rc.1` after `0.2.2-rc.10`.

Subsequent rollout preparation surfaced three engineering gaps:

1. **Namespace collision risk**: local builds and draft release handoffs stayed on `0.2.2-rc.*` (such as `0.2.2-rc.10.20261119.2` and a proposed `0.2.2-rc.11`), sharing the `0.2.x` namespace with upstream `0.2.2-rc.5`. Once upstream advances to matching `0.2.2-rc.*` or `0.2.2`, identical version numbers would refer to unrelated codebases across users, support, and engineering.
2. **Prerelease dated-build SemVer trap**: `electron-updater` compares versions with `semver.gt`. Under SemVer, appending a date to a prerelease base (`0.2.2-rc.10.20261119.2`) ranks **higher** than the prerelease base (`0.2.2-rc.10`), stranding test machines from updating to that RC; by contrast, appending `-test` to a stable target (`1.0.1-test.20261119.1`) ranks **lower** than the stable release (`1.0.1`), allowing test machines to upgrade naturally.
3. **Runtime observability gap**: `ADR 0005` left exposing the upstream baseline version in the About dialog out of scope. With frequent upstream merges alongside Kito fixes, production triage (screenshots, local crash logs, Sentry alerts) needs both the Kito product version and the bundled `dsh` core version immediately without cross-referencing git tags.

## Decision

Adopt the enterprise soft-fork model (as used by Cursor/VS Code and Brave/Chromium): **strictly decoupled dual version lines with dual-version runtime observability**.

### 1. Decoupled version lines

| Line | Source of truth | Progression rule | Consumers |
|---|---|---|---|
| **Kito product version** | `kt/kito-harness/version.json` | Cuts over from `0.2.2-rc.10` to `1.0.0-rc.1`, then increments monotonically along `1.x` SemVer, **permanently retiring `0.2.x`** | Installer filenames, `app.getVersion()`, download page and `latest.json`, `DSH_CLIENT_VERSION`, Sentry `release`, GitHub Release tags (`kito-harness-v<version>`) |
| **Upstream `dsh` core version** | Root and workspace `package.json` files (including `@kito/*`) | Matches the latest merged upstream release tag (`0.2.2-rc.5`), changing only on upstream tag merges | Bundled runtime (`desktop-runtime.json`), `dsh --version`, plugin `engines.dsh` compatibility, `pnpm run constraints`, mandatory update header `x-client-bundled-dsh-version` |

SemVer semantics for Kito product versions:

- **`MAJOR` (`X.0.0`)**: breaking Kito product restructuring or incompatible storage/account migrations.
- **`MINOR` (`1.X.0`)**: significant upstream feature merges or new Kito product capabilities (such as new sign-in or billing flows).
- **`PATCH` (`1.0.X`)**: Kito bug fixes (such as account/wallet isolation) or minor upstream patch merges.
- **`-rc.N`**: pre-release candidates ahead of a stable cut; dropping `-rc.N` (`1.0.0 > 1.0.0-rc.N`) upgrades installed clients seamlessly.

### 2. Decouple upstream synchronization from product releases

- **Upstream sync commits / PRs**: merge the upstream `dsh-v*` tag, align `@kito/*` `package.json` versions, and fix regressions without editing `kt/kito-harness/version.json`.
- **Kito release commits / PRs**: bump only `kt/kito-harness/version.json` (plus final release fixes), leave all `package.json` manifests untouched, never run `pnpm release:dsh`, and never push `dsh-v*` tags.

### 3. Dual-version runtime observability (amends `ADR 0005` non-goals)

Primary user-facing surfaces (download page, sidebar version badge, installer names) continue to highlight the Kito product version alone. Whenever the bundled `dsh` core version in `desktop-runtime.json` differs from `app.getVersion()`, diagnostic surfaces report both:

- **macOS About panel**: `applicationVersion` shows the Kito version and `version` carries `dsh <dsh version>` (rendered natively as `1.0.0-rc.1 (dsh 0.2.2-rc.5)`).
- **Windows About dialog**: appends `Core: dsh <dsh version>` beneath the product version line.
- **Local crash reports (`crash-*.log`)**: adds `core: dsh <dsh version>` directly below `app:`.
- **Sentry**: sets `release` to the Kito product version and tags both `initialScope` and every `captureKitoFailure` event with `dsh.core_version`.
- **GitHub Release notes**: always include `Kito Harness <product>, based on DeepSeek Harness <dsh>`.

In unpackaged development runs or when both versions are equal, the extra core line is omitted so upstream snapshots stay unchanged.

### 4. Strict separation of release and preview channels

- **Production releases**: built exclusively from an immutable `main` commit via `.github/workflows/release-desktop.yml` (macOS arm64 PKG/DMG and Windows x64 EXE from the same CI run), with clean SemVer (no date suffix) and an immutable `kito-harness-v<ProductVersion>` tag.
- **Local / preview builds**: for operator or isolated-channel verification only; **never write them to production `kito-harness-latest/latest.json`**. Once on a stable version line, preview builds target the next release as `<next>-test.<YYYYMMDD>.<seq>` (`1.0.1-test.20261119.1 < 1.0.1`) so preview installs upgrade cleanly when the release ships.

## Rationale

1. **`1.0.0-rc.1` cleanly breaks away from `0.2.x`**: under `semver.gt`, `1.0.0-rc.1` outranks both public `0.2.2-rc.10` and dated local builds (`0.2.2-rc.10.20261119.2`), while separating the major version from upstream `0.2.x` for years to come.
2. **Zero duplicated version sources**: `desktop-runtime.json` already seals and verifies the bundled `dsh` version during packaging, so the main process reads `readDesktopRuntime(runtimeResources().dsh).release.version` directly.
3. **Zero upstream test drift**: gating the extra core version line on `bundledDshVersion !== app.getVersion()` preserves every upstream About and crash-report snapshot.

## Reapply on upstream merges

| File | Must remain |
|---|---|
| `kt/kito-harness/version.json` | Independent `1.x` Kito product version line, never reverted to `0.2.x` |
| `apps/desktop/src/main.ts` | `resolveBundledDshVersion()`; pass `coreVersion` to macOS/Windows About, `persistCrashReport`, and `initKitoSentry` |
| `apps/desktop/src/kito-sentry.ts` | Attach `dsh.core_version` tag in `initKitoSentry` and `captureKitoFailure` |
| `apps/desktop/src/crash-report.ts` | `CrashReportApp.coreVersion` and `core: dsh <version>` header line |

## Consequences

- Starting with `1.0.0-rc.1`, Kito Harness stops issuing `0.2.2-rc.*` product versions.
- About screenshots, local `crash-*.log` files, and Sentry events immediately identify both the Kito shell version and the bundled `dsh` core version.
- The non-goal in `ADR 0005` excluding the upstream baseline version from About is superseded by this ADR; all other `ADR 0005` decisions remain in effect.
