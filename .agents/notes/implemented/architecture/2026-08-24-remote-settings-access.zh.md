# Agent Note: 设置面与凭据面随浏览器信任栅栏放行

Status: implemented

[English](2026-08-24-remote-settings-access.md) | 中文

## 问题

一个从受信权威（Web 运行时推导入 `trustedHosts` 的 Tailscale 或 LAN IP，或已声明的 `trustedHosts` 名称）提供 GUI 服务的部署，能加载应用却不能使用它：设置数据面（`settings.describe`/`update`/`replace`/`mutate`）与凭据面（`credentials.describe`/`set`/`unset`）被钉在回环，因此受信远程浏览器看到 Models 页拒绝加载提供方目录，主题、locale 与引导偏好也没有持久化归宿。客户端为这层不对称付出了第二重代价：每个 settings 消费方都携带双模式——回环页面走 wire scope，其余一律走进程内 memory 回退——而 welcome 确认在回环上走 wire、在其余环境退化为进程内替代。

## 决策

钉住（pin）从设置数据面与凭据面上移除。两面现在与其他所有 `/api` 方法一样，随同一道 `trustedHosts` 栅栏放行：任何能加载应用的浏览器都能读写配置与凭据；部署从未声明的浏览器在它们身上与在其他任何方法上一同被拒。信任了服务权威的部署——Web 运行时从全接口服务器配置推导非内网 IPv4 字面量，`trustedHosts` 声明其余——无需任何额外配置即获得完整的配置界面。

仍钉在回环的方法集，是那些作用于 Host 桌面或携带草稿机密的方法：`host.pickDirectory` 与 `host.openPath`（原生对话框，以及向宿主自己的屏幕与默认应用交接）、`settings.openDocument`（实体化设置文档并交给该桌面上的原生编辑器）、`llm.discoverModels`（草稿凭据加一个由调用方选定的、由 Host 发起 GET 的 URL），以及 agent preset 创作面 `agentPreset.read`/`copy`/`openDocument`/`remove`（组装指明了一个会话所运行的插件）。`agentPreset.list`/`select` 与模型目录保持普通。

客户端的每个 settings scope 都经栅栏走 wire；memory 回退已移除。被拒的读取会把一个从未加载成功的 scope 收敛到终态 `unavailable`（已持有分节的 scope 在被拒的刷新中保留该分节）；被拒的写入则让本地偏好原样保留。welcome 步骤以同一方式走 wire 持久化其确认，并在 namespace 无法读取时于阻塞弹窗内显示一行本地化错误。

安全框架不变：栅栏是可达性策略，不是认证。让这变得安全的是结构性事实——能触达任何 `/api` 方法的浏览器已经通过了栅栏，因此在功能完好的部署上不存在「应用可用但设置被拒」的状态；客户端呈现的被拒读取状态只可能来自瞬时的传输失败。

## 曾考虑的替代方案

- **按部署提供解锁两面的配置开关。** 被否决：该开关按部署切换整个配置面，却没有增加栅栏尚未提供的任何安全性质——信任了某个权威的部署早已声明该表面可触达——而且每个消费方仍要携带两条传输。
- **只解锁写入、保留读取的钉住。** 被否决：读写分裂会把 `settings.describe`（它返回已暴露的配置）单独留在回环，而受信远程却只能盲写；一个面在每个客户端消费方身上被拆进两条传输。
- **对被拒部署保留进程内回退。** 被否决：双模式正是本决策移除的代价；受信部署如今是常态，而被拒读取的 `unavailable` 状态已为被拒 scope 提供了终态且诚实的状态。

## 影响

- 受信远程部署——包括运行时推导入 `trustedHosts` 的 Tailscale IP——获得完整的设置与凭据界面。不受信浏览器的 settings scope 收敛为 `unavailable`，主题与 locale 保留各自的系统派生／navigator 派生的暂定偏好。
- `settings.openDocument`、`host.*` 桌面动作、`llm.discoverModels` 与 agent preset 创作面仍钉在回环。pin 集在 connection 测试套件中经一台真实 HTTP 服务器断言：受信主机在未钉住的面上是 404（载体应答——栅栏已放行）、在钉住的方法上是 403；未声明的主机两者皆 403。
- settings scope 快照失去 `mode` 字段；welcome 弹窗的错误状态成为被拒 welcome 读取的可见形态。
- 本 note 部分取代的、配置面回环钉住的决策记录见[配置面边界 note](2026-07-30-config-plane-boundaries.md)；栅栏本身见[浏览器信任边界 note](2026-07-28-api-browser-trust-boundary.md)；远程偏好的持久化边界见[Host 支撑的偏好 note](../bug-fix/2026-08-06-host-backed-web-preferences.md)；welcome 步骤的持久化字段见[共用弹窗产品引导 note](../feature/2026-08-13-shared-modal-product-onboarding.md)。
