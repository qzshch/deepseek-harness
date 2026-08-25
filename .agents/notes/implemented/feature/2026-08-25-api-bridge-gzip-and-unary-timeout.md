# Agent Note: gzip-compress /api responses and widen the unary RPC deadline

Status: implemented

English | [中文](2026-08-25-api-bridge-gzip-and-unary-timeout.zh.md)

## Problem

A remote browser reaches the GUI over a low-bandwidth tunnel — a Tailscale DERP relay or a slow LAN hop. Two symptoms came out of the same root cause. First, the session list (`session.list`) returns one full summary per session, and with hundreds of sessions the response is a multi-hundred-KiB JSON envelope that the server sends **uncompressed** (it ignores `Accept-Encoding`), so on a ~30 KB/s relay the list alone takes 15–30 s. Second, bounded unary RPCs abort after a hard 30 s (`DEFAULT_TIMEOUT_MS = 30_000`), so a list that crosses the deadline fails the whole read. The client's `refreshList` treats a failed list as an empty baseline, and newly created sessions still arrive through the `host/session-added` stream — a user over the tunnel ends up seeing only the sessions they just created, with every older session gone from the sidebar. The data was always intact on disk; only the transport timed out.

## Decision

The `/api` bridge (`packages/client/connection/src/http-bridge.ts`) now gzip-compresses response bodies for gzip-capable clients. A request that advertises `Accept-Encoding: gzip` gets its complete JSON envelope buffered and passed through `gzipSync` when the body is at least `GZIP_MIN_BYTES` (1 KiB) and compression actually shrinks it; the response then carries `Content-Encoding: gzip`, a corrected `Content-Length`, and `Vary: Accept-Encoding`. Everything else — non-gzip clients, tiny bodies, incompressible payloads — keeps the existing streaming write path untouched. Buffering is safe because the `/api` carrier serves complete envelopes, not HTTP streams (the two event channels are WebSockets and never pass through this bridge). The 555 KiB session list compresses to ~65 KiB, cutting the relay time from ~18 s to ~2 s.

The bounded-unary deadline widens from 30 s to 120 s (`DEFAULT_TIMEOUT_MS` in `packages/host/apiproxy/src/fetch/client.ts`). The 30 s value assumed a loopback host; a remote host over a relay needs headroom above the tunnel RTT for large envelopes even after compression. The deadline still aborts a genuinely hung host, so the original "a hung host must not leave callers pending forever" property is preserved.

## Alternatives considered

- **Compress in the webserver layer for every response.** Rejected: it would wrap static files and streams it does not own, risk double-encoding, and require a res wrapper in the shared server; the bridge owns the RPC envelope and is the single place a complete JSON body is known.
- **Only widen the deadline.** Rejected: it trades one timeout for a slow-but-eventual load on a link that may not sustain the transfer, and it does nothing for the equally slow history reads that motivated #470.
- **Stream gzip via `createGzip()`.** Rejected: it keeps the envelope from one-pass buffering and complicates the `Content-Length` accounting for no gain on the ~1 KiB–1 MiB RPC envelope scale.

## Consequences

- Remote deployments (Tailscale/LAN) load the session list and large RPC envelopes in seconds instead of timing out at 30 s; the sidebar shows the full history again.
- `Vary: Accept-Encoding` keeps shared caches from serving a gzip body to a non-gzip client.
- The deadline is now 120 s for all bounded unary calls; user-paced and streaming paths are unaffected.
- The transport change is content-agnostic: session history and context are transmitted as-is, only the on-the-wire encoding changes, so the no-compaction / no-folding constraint on session content is untouched.
- Related prior art: the low-bandwidth history failure mode is documented in the community as Discussion #470.
