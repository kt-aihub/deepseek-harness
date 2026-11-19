# ADR 0006：Kito Harness 企业级版本治理与上游基线可观测性

[English](0006-kito-versioning-governance-and-core-observability.md) | 中文

日期：2026-11-19

状态：已接受（补充并修订 `ADR 0005`）

## 背景

`ADR 0005` 确立了两条独立版本线：所有 `package.json` 跟随已合并的上游 `dsh` 发行版本，`kt/kito-harness/version.json` 保存 Kito Harness 自己的产品版本，并计划在 `0.2.2-rc.10` 之后切入 `1.0.0-rc.1`。

但在后续实际发版准备中暴露出三处工程缺口：

1. **号段回流与撞号风险**：本地验收与交接计划继续沿用 `0.2.2-rc.*`（如 `0.2.2-rc.10.20261119.2` 与预期的 `0.2.2-rc.11`），与上游 `0.2.2-rc.5` 共享 `0.2.x` 命名空间。一旦上游推进到更高 `0.2.2-rc.*` 或 `0.2.2` 正式版，两边的同号版本将指向完全不同的代码，用户、客服与研发都会混淆。
2. **预发布带日期构建的 SemVer 排序陷阱**：`electron-updater` 使用 `semver.gt` 做向上更新判断。在 SemVer 中，预发布基线追加日期（`0.2.2-rc.10.20261119.2`）**大于**原预发布基线（`0.2.2-rc.10`），装过本地验收包的机器无法更新回同号正式 RC；而稳定基线追加 `-test`（`1.0.1-test.20261119.1`）**小于**目标稳定版（`1.0.1`），测试机可以自然升级到正式版。
3. **运行期缺少上游内核版本可观测性**：`ADR 0005` 曾将「在关于窗口暴露上游基线版本」列为非目标。但在频繁同步上游与叠加密集 Kito 定制修复的节奏下，线上排障（用户截图、崩溃日志、Sentry 告警）需要一眼同时确认「Kito 壳版本 + 内置 `dsh` 内核版本」，单看 Kito 版本号必须再去反查 git tag。

## 决策

采用成熟商业开源发行版（如 Cursor / VS Code、Brave / Chromium）的**双版本线完全解耦 + 运行期双维度可观测**规范：

### 1. 两条版本线彻底隔离、职责清晰

| 维度 | 事实源 | 演进规则 | 消费者 |
|---|---|---|---|
| **Kito 产品版本（Product Version）** | `kt/kito-harness/version.json` | 本次从 `0.2.2-rc.10` 正式切入 `1.0.0-rc.1`，从此沿 `1.x` 遵循标准 SemVer 单调递增，**永久退出 `0.2.x` 号段** | 安装包文件名、`app.getVersion()`、下载页与 `latest.json`、`DSH_CLIENT_VERSION`、Sentry `release`、GitHub Release tag（`kito-harness-v<version>`） |
| **上游内核版本（dsh Core Version）** | 根与各工作区 `package.json`（含 `@kito/*`） | 严格等于最近一次合并的上游发行 tag（当前 `0.2.2-rc.5`），仅在同步上游 tag 时变更 | 随包运行时（`desktop-runtime.json`）、`dsh --version`、插件 `engines.dsh` 兼容校验、`pnpm run constraints`、强制更新策略头 `x-client-bundled-dsh-version` |

Kito 产品版本的 SemVer 语义约定：

- **`MAJOR`（`X.0.0`）**：Kito 产品级重大重构或不兼容的数据目录、账号体系迁移。
- **`MINOR`（`1.X.0`）**：合并上游重要特性版本，或 Kito 上线独立核心能力（如新登录流、计费/控制台能力）。
- **`PATCH`（`1.0.X`）**：Kito 自身缺陷修复（如账号隔离与钱包会话修复）或跟进上游小补丁。
- **`-rc.N`**：正式版前的候选版本；稳定后直接去掉后缀（如 `1.0.0 > 1.0.0-rc.N`），所有已安装客户端可无缝向上升级。

### 2. 上游同步与产品发版解耦

- **上游同步提交 / PR**：只做合并上游 `dsh-v*` tag、对齐 `@kito/*` 的 `package.json` 版本与冲突回归，**不同时修改 `kt/kito-harness/version.json`**。
- **Kito 发版提交 / PR**：只修改 `kt/kito-harness/version.json`（或随最终发布修复收口），不改动任何 `package.json`，不运行 `pnpm release:dsh`，不推送 `dsh-v*` tag。

### 3. 运行期暴露上游内核版本（修订 `ADR 0005` 非目标）

对外主界面（下载页、侧栏版本角标、安装包文件名）仍只突出展示 Kito 产品版本；当打包运行时的 `dsh` 内核版本（来自 `desktop-runtime.json`）与 Kito 产品版本不同时，运行期在所有诊断面同时暴露 `dsh` 内核版本：

- **macOS「关于」面板**：`applicationVersion` 为 Kito 产品版本，`version` 填 `dsh <dsh 版本>`（系统原生呈现为 `1.0.0-rc.1 (dsh 0.2.2-rc.5)`）。
- **Windows「关于」对话框**：在产品版本行下附加 `Core: dsh <dsh 版本>`。
- **本地崩溃报告（`crash-*.log`）**：在 `app:` 行下方新增 `core: dsh <dsh 版本>`。
- **Sentry**：`release` 为 Kito 产品版本，同时在 `initialScope.tags` 与每次 `captureKitoFailure` 的 `tags` 写入 `dsh.core_version`。
- **GitHub Release 说明**：固定注明 `Kito Harness <product>, based on DeepSeek Harness <dsh>`。

开发态或 `dsh` 版本与产品版本一致时，不额外拼接内核行，保持与上游测试快照兼容。

### 4. 正式通道与本地/内部预览通道隔离

- **生产发布包**：只能从已合入 `main` 的不可变 commit 经 `.github/workflows/release-desktop.yml` 原生构建（macOS arm64 PKG/DMG 与 Windows x64 EXE 来自同一 CI run），版本号不带日期后缀，对应不可变 tag `kito-harness-v<ProductVersion>`。
- **本地/内部验收包**：仅用于操作者本机或隔离测试通道验收，**严禁写入生产 `kito-harness-latest/latest.json`**。产品转入稳定号段（无 `-rc`）后，预览构建使用下一目标版本的 `-test.<YYYYMMDD>.<seq>`（例如 `1.0.1-test.20261119.1 < 1.0.1`），避免测试机被锁死在比目标正式版更高的预发布号上。

## 理由

1. **`1.0.0-rc.1` 一步到位消除历史包袱**：在 `semver.gt` 下，`1.0.0-rc.1` 严格大于公开的 `0.2.2-rc.10` 以及所有带日期的本地构建（`0.2.2-rc.10.20261119.2`），同时主版本号 `1` 与上游 `0.2.x` 在视觉和语义上彻底拉开，未来数年不再撞号。
2. **复用现有运行时元数据，几乎零维护成本**：打包产物里的 `desktop-runtime.json` 已经由构建流程校验并封存了真实的 `dsh` 版本，主进程直接通过 `readDesktopRuntime(runtimeResources().dsh).release.version` 读取，无需额外维护第二份硬编码常量。
3. **不破坏上游测试基线**：仅当 `bundledDshVersion !== app.getVersion()` 时输出内核副行，上游所有默认同号测试和快照保持零回归。

## 上游合并时重放

| 文件 | 必须仍在 |
|---|---|
| `kt/kito-harness/version.json` | 保持 Kito 独立产品版本线（`1.x`），不回退到 `0.2.x` |
| `apps/desktop/src/main.ts` | `resolveBundledDshVersion()`；macOS/Windows「关于」、`persistCrashReport` 与 `initKitoSentry` 透传 `coreVersion` |
| `apps/desktop/src/kito-sentry.ts` | `initKitoSentry` 与 `captureKitoFailure` 附带 `dsh.core_version` tag |
| `apps/desktop/src/crash-report.ts` | `CrashReportApp.coreVersion` 与 `core: dsh <version>` 报告头行 |

## 后果

- 从 `1.0.0-rc.1` 起，Kito Harness 不再发布任何 `0.2.2-rc.*` 版本号。
- 线上用户提供「关于」截图、本地 `crash-*.log` 或触发 Sentry 告警时，可直接同时确认 Kito 产品版本与底层 `dsh` 内核版本。
- `ADR 0005` 中「“关于”窗口不显示上游基线版本」一项由本 ADR 修订替代，其余决策继续有效。
