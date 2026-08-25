# Agent Note: gzip-compress /api responses

Status: implemented

English | [中文](2026-08-25-api-bridge-gzip-and-unary-timeout.zh.md)

## Problem

A remote browser reaches the GUI over a low-bandwidth tunnel — a Tailscale DERP relay or a slow LAN hop. The session list (`session.list`) returns one full summary per session, and with hundreds of sessions the response is a multi-hundred-KiB JSON envelope that the server sends **uncompressed** (it ignores `Accept-Encoding`), so on a ~30 KB/s relay the list alone takes 15–30 s. The client's `refreshList` treats a slow or failed list as an empty baseline while newly created sessions still arrive through the `host/session-added` stream — a user over the tunnel sees only the sessions they just create, with every older session missing from the sidebar. The data is always intact on disk; only the transport is too slow.

## Decision

The `/api` bridge (`packages/client/connection/src/http-bridge.ts`) gzip-compresses response bodies for gzip-capable clients. A request that advertises `Accept-Encoding: gzip` gets its complete JSON envelope buffered and passed through `gzipSync` when the body is at least `GZIP_MIN_BYTES` (1 KiB) and compression actually shrinks it; the response then carries `Content-Encoding: gzip`, a corrected `Content-Length`, and `Vary: Accept-Encoding`. Everything else — non-gzip clients, tiny bodies, incompressible payloads — keeps the existing streaming write path untouched. Buffering is safe because the `/api` carrier serves complete envelopes, not HTTP streams (the two event channels are WebSockets and never pass through this bridge). The 555 KiB session list compresses to ~65 KiB, cutting the relay time from ~18 s to ~2 s.

The original change also widened the bounded-unary deadline from 30 s to 120 s in `packages/host/apiproxy/src/fetch/client.ts`. That half is **dropped** against the 0.1.2 alpha base: the `apiproxy` package no longer exists after the API gateway / Typert Remotes rework, and the current `packages/api/gateway` and `packages/api/remotes` unary paths carry no equivalent hard 30 s default (verified by search). If a hung-host hang timeout is ever wanted again, it belongs to a separate change against the new gateway with its own note.

## Alternatives considered

- **Compress in the webserver layer for every response.** Rejected: it would wrap static files and streams it does not own, risk double-encoding, and require a res wrapper in the shared server; the bridge owns the RPC envelope and is the single place a complete JSON body is known.
- **Only widen a deadline.** Rejected: it trades one timeout for a slow-but-eventual load on a link that may not sustain the transfer, and it does nothing for the equally slow history reads that motivated #470. (Also moot on the new base — see Decision.)
- **Stream gzip via `createGzip()`.** Rejected: it keeps the envelope from one-pass buffering and complicates the `Content-Length` accounting for no gain on the ~1 KiB–1 MiB RPC envelope scale.

## Consequences

- Remote deployments (Tailscale/LAN) load the session list and large RPC envelopes in seconds; the sidebar shows the full history again.
- `Vary: Accept-Encoding` keeps shared caches from serving a gzip body to a non-gzip client.
- The transport change is content-agnostic: session history and context are transmitted as-is, only the on-the-wire encoding changes, so the no-compaction / no-folding constraint on session content is untouched.
- Related prior art: the low-bandwidth history failure mode is documented in the community as Discussion #470.