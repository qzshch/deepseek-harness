# Agent Note: 客户端设置的「双模式」离开浏览器

Status: implemented

[English](2026-08-30-remote-settings-access-v2.md) | 中文

## 问题

当前基线的服务端早已移除了设置面与凭据面上的方法级钉住：API 面不再有回环层，浏览器信任栅栏（`src/api-request-trust.ts`）对所有 `/api` 方法统一适用。客户端却仍在为旧不对称付费：其设置消费方携带双模式——共享的 `settings.describe` mirror 与每个 scope 都知道 `host`/`memory` 两种模式，非回环页面上的 scope 从不经过 wire，快照以 `unavailable` 起步——welcome 确认在非回环上退化为进程内替代。受信、已认证的远程浏览器（`trustedHosts` 权威，经栅栏完成 cookie 认证）能加载应用却不能使用其配置面：Models 页拒绝加载提供方目录，主题与 locale 没有持久化归宿，welcome 提示每次刷新后重复出现。

## 决策

客户端丢弃双模式。每个 settings scope 现在都经栅栏走 wire；设置数据面不再保留任何浏览器身份门，服务端也不重新引入任何方法级钉住。

- 共享 mirror 的状态收窄为 `idle | loading | ready`。一次未获应答的读取保留错误并停在 `idle`，可重试；mirror 不再知道终态。
- 终态不可用在 scope 层收敛。`convergeDeniedRead` 在 mirror 持有错误且无视图时，把从未持有分节的 scope 收敛为 `unavailable`；已持有分节的 scope 在被拒刷新中保留该分节，并在下一次成功读取后回到 `ready`。
- `SettingsScopeSnapshot` 失去 `mode` 字段，scope 的 `writable` 反映持久化文档。
- welcome 确认只走持久化：该步骤在 Host 设置面比较并写入 `ui-onboarding.welcomeNoticeVersion`；读取从未应答时在弹窗内显示一行本地化的不可用提示。
- open-document 操作对每个浏览器注册：其可用性派生自共享 mirror 的 `hasDocument` 应答，而非页面的回环身份。Host 仍然实体化文档并交给其自身桌面的原生编辑器，因此即便由远程页面触发，该操作也仍是桌面交接。

安全框架不变：栅栏是可达性策略，不是认证。让这变得安全的是结构性事实——能触达任何 `/api` 方法的浏览器已经通过了栅栏，因此在功能完好的部署上不存在「应用可加载但设置被拒」的状态；scope 呈现的被拒读取收敛同时服务于拒绝与瞬时传输失败。

## 曾考虑的替代方案

- **在当前基线上按方法重新钉住设置面。** 被否决：它会同时重建服务端与客户端这一系列工作要移除的不对称，换来的却只是栅栏已经提供的安全性质。
- **保留 memory 模式作为远程或被拒浏览器的默认。** 被否决：双模式正是被移除的代价；受信远程浏览器如今是常态，而 scope 的 `unavailable` 收敛已为被拒读取提供了终态且诚实的状态。
- **把终态 `unavailable` 留在共享 mirror 本身。** 被否决：mirror 是每个 scope 的唯一 `settings.describe` 读取者；一次失败的读取必须保持可重试，而不能让所有依赖的 scope 都进入终态不可用。收敛属于 scope 层——分节的生命周期在那里。

## 影响

- 受信、已认证的远程浏览器获得完整的设置与凭据面。welcome 确认持久化在 Host 文档中，刷新后不再重复出现；远程 welcome e2e 端到端断言该持久化行为。
- `SettingsScopeSnapshot` 失去 `mode`，`SettingsMirrorSnapshot` 失去 `unavailable`。scope 的 `unavailable` 状态现在只有一个入口：持有错误且无视图时的收敛。
- open-document 操作对每个浏览器注册。它仍是桌面交接——Host 解析提供方路径、实体化文档并打开其原生编辑器——因此远程页面的触发作用于 Host 桌面，而非页面自身所在机器。
- 本 note 在新基线上重新落地 2026-08-24 remote-settings-access 决策（保留在 `legacy/remote-settings-access` 分支）的服务端钉住移除的客户端侧，并取代该 note 中 `settings.openDocument` 的钉住——本 note 的 open-document 注册将其移除。栅栏本身见[浏览器信任边界 note](2026-07-28-api-browser-trust-boundary.zh.md)；钉住最初的配置面表述见[配置面边界 note](2026-07-30-config-plane-boundaries.zh.md)；共享 mirror 见[settings-describe mirror note](2026-08-17-settings-describe-mirror.zh.md)；远程偏好的持久化边界见[Host 支撑的偏好 note](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)；welcome 步骤的持久化字段见[共用弹窗产品引导 note](../feature/2026-08-13-shared-modal-product-onboarding.zh.md)。