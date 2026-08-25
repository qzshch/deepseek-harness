# Agent Note：/api 响应 gzip 压缩并放宽 unary RPC 超时

Status: implemented

[English](2026-08-25-api-bridge-gzip-and-unary-timeout.md) | 中文

## 问题

远程浏览器经由低带宽隧道（Tailscale DERP 中继或慢速局域网跳）访问 GUI，两个症状出自同一个根因。其一，会话列表（`session.list`）为每个会话返回一份完整摘要，会话数以百计时响应是几百 KiB 的 JSON 信封，而服务端**不做任何压缩**（忽略 `Accept-Encoding`），于是 ~30 KB/s 的中继上仅列表就要 15–30 秒。其二，有界 unary RPC 在硬性 30 秒（`DEFAULT_TIMEOUT_MS = 30_000`）后中止，列表一旦超时就整读失败。前端 `refreshList` 把失败视为空基线，而新建会话仍经 `host/session-added` 流增量到达——隧道上的用户最终只看到刚建的会话，侧边栏里所有更早的会话都不见了。数据在磁盘上始终完好，超时的只是传输层。

## 决策

`/api` 桥（`packages/client/connection/src/http-bridge.ts`）现在对支持 gzip 的客户端压缩响应体。声明 `Accept-Encoding: gzip` 的请求，其完整 JSON 信封在体积达到 `GZIP_MIN_BYTES`（1 KiB）且压缩确有收益时被缓冲并经 `gzipSync` 压缩，随后响应携带 `Content-Encoding: gzip`、修正后的 `Content-Length` 与 `Vary: Accept-Encoding`。其余一切——非 gzip 客户端、小体积、不可压缩负载——保持原有流式写出路径不变。缓冲是安全的，因为 `/api` 载体只提供完整信封而非 HTTP 流（两个事件通道是 WebSocket，从不经过此桥）。555 KiB 的会话列表压缩到约 65 KiB，中继耗时从约 18 秒降到约 2 秒。

有界 unary 截止时间由 30 秒放宽到 120 秒（`packages/host/apiproxy/src/fetch/client.ts` 中的 `DEFAULT_TIMEOUT_MS`）。30 秒的取值假设是回环主机；经中继的远程主机即使压缩后也需要在隧道 RTT 之上为大体量信封留出余量。该截止时间仍会中止真正挂起的 host，因此"挂起的 host 不能无限期拖住调用方"这一原始性质得以保留。

## 备选方案

- **在 webserver 层对所有响应压缩。** 否决：会包住它不拥有的静态文件与流，有双重编码风险，还要求在共享服务器里加一个 res 包装器；桥拥有 RPC 信封，是唯一能得知完整 JSON 体的位置。
- **只放宽截止时间。** 否决：只是把一次超时换成慢速但终究能加载，而那条链路未必撑得住传输，且对同样缓慢、促成 #470 的历史读取毫无帮助。
- **用 `createGzip()` 流式压缩。** 否决：破坏了单次缓冲，且让 `Content-Length` 核算变复杂，在 ~1 KiB–1 MiB 的 RPC 信封规模上并无收益。

## 后果

- 远程部署（Tailscale/局域网）以秒级加载会话列表与大体量 RPC 信封，不再在 30 秒处超时；侧边栏恢复显示完整历史。
- `Vary: Accept-Encoding` 让共享缓存不会把 gzip 体交给非 gzip 客户端。
- 所有有界 unary 调用的截止时间变为 120 秒；用户节奏与流式路径不受影响。
- 该传输改动与内容无关：会话历史与上下文按原样传输，只改线上编码，因此"不压缩/不折叠会话内容"的约束不受触碰。
- 相关先例：低带宽历史加载失败模式在社区记录为 Discussion #470。
