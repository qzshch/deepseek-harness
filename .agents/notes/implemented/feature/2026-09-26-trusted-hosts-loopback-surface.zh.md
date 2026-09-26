# Agent Note: 受信主机的回环面

Status: implemented

[English](2026-09-26-trusted-hosts-loopback-surface.md) | 中文

## 问题

绑定 `0.0.0.0` 并在 `trustedHosts` 里登记了对外服务名的部署，其非回环页面仍被划为无特权：`ctx.connection.isLoopback` 只按页面 hostname 判定，宿主持久化的客户端能力（settings describe 镜像与设置文档控制器）在局域网、tailnet 页面上报 "settings are unavailable in this browser"——尽管请求围栏早已为这些权威背书。

## 决策

宿主把配置的 `trustedHosts` 随 `__DSH_CONNECTION_RECOVERY__` 一并注入服务页面；客户端连接在页面权威命中某条目时按回环对待：裸 `host` 条目匹配任意端口，`host:port` 条目（含方括号 IPv6）还要求端口一致，无端口的页面永不匹配带端口的条目。当前只有两处 settings 消费者读取该事实；围栏、浏览器认证与客户端 IP 白名单的行为不变。

## 考虑过的替代方案

**把 settings 镜像一律视为宿主持久化。** 这会把该能力授予部署从未背书的页面；权威清单把决定权留给围栏自身的信任集。

**发布宿主计算的连接事实。** 回环性依赖宿主看不到的页面位置；注入清单让判定留在客户端、缺省时安全关闭。

## 后果

受信名称服务的页面在下次加载后获得宿主持久化的设置；从未离开回环的部署行为不变——缺省注入为空列表。
