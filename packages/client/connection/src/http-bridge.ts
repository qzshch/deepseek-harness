/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { ConnectionFetchHandler } from './rpc.ts'

/** Default carrier cap for all HTTP RPC bodies: sized for the default
 * aggregate image limit (200 MiB) after base64 expansion plus envelope
 * headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
 * each body in memory, so this cap is also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

interface BridgeServerResponse {
  readonly destroyed: boolean
  readonly writableEnded: boolean
  on(event: 'close', listener: () => void): this
  off(event: 'close' | 'drain', listener: () => void): this
  once(event: 'close' | 'drain', listener: () => void): this
  writeHead(statusCode: number, headers?: Record<string, string>): unknown
  write(chunk: Uint8Array): boolean
  end(): unknown
}

/** Response bodies at least this large are gzip-compressed for gzip clients
 * (tiny RPC answers would cost more CPU than they save on the wire). */
export const GZIP_MIN_BYTES = 1024

/** Whether the request's Accept-Encoding advertises gzip. */
function acceptsGzip(req: IncomingMessage): boolean {
  const value = req.headers['accept-encoding']
  return typeof value === 'string' && /\bgzip\b/i.test(value)
}

/** Append one token to an existing Vary header value, deduplicated. */
function mergeVary(existing: string | null, token: string): string {
  if (existing === null || existing === '') return token
  return existing.split(',').map(part => part.trim()).includes(token) ? existing : `${existing}, ${token}`
}

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; response writes respect backpressure and stop on disconnect).
 * @param req - incoming node:http request.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum bytes buffered for a buffered route.
 */
export async function bridge(
  req: IncomingMessage,
  res: BridgeServerResponse,
  apiHandler: ConnectionFetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort a
  // streaming response right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  /* v8 ignore next 2 -- node:http always sets url/method on server requests. */
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = req.method ?? 'GET'
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
  )
  const bodyMode = apiHandler.requestBodyMode({ method, url })
  let request: Request
  if (bodyMode === 'buffered') {
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      received += buffer.byteLength
      if (received > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      chunks.push(buffer)
    }
    request = new Request(url, {
      method,
      headers,
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
      signal: abort.signal,
    })
  } else {
    request = new Request(url, {
      method,
      headers,
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  }
  const response = await apiHandler.fetch(request)
  const requestUnread = bodyMode === 'streaming' && !req.readableEnded
  const responseHeaders = new Headers(response.headers)
  if (acceptsGzip(req) && response.body !== null) {
    // Gzip-capable clients pay one full buffering pass so the (already fully
    // realized JSON) RPC body can be compressed before hitting the wire; the
    // /api carrier serves complete envelopes, not HTTP streams, so buffering
    // never delays a progressive response here.
    const chunks: Buffer[] = []
    for await (const chunk of response.body) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const compressed = raw.length >= GZIP_MIN_BYTES ? gzipSync(raw) : null
    if (compressed !== null && compressed.length < raw.length) {
      responseHeaders.delete('content-length')
      responseHeaders.set('content-encoding', 'gzip')
      responseHeaders.set('content-length', String(compressed.length))
      responseHeaders.set('vary', mergeVary(responseHeaders.get('vary'), 'Accept-Encoding'))
    }
    const headerRecord = Object.fromEntries(responseHeaders.entries())
    res.writeHead(response.status, requestUnread ? { ...headerRecord, connection: 'close' } : headerRecord)
    res.end(compressed ?? raw)
    if (requestUnread) req.destroy()
    return
  }
  const responseHeaderRecord = Object.fromEntries(responseHeaders.entries())
  res.writeHead(response.status, requestUnread ? { ...responseHeaderRecord, connection: 'close' } : responseHeaderRecord)
  if (response.body === null) {
    res.end()
    if (requestUnread) req.destroy()
    return
  }
  for await (const chunk of response.body) {
    // Drain without writing after disconnect: cancelling Node multipart bodies
    // can race their producer and reject with ERR_INVALID_STATE.
    if (abort.signal.aborted) continue
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow or suspended consumers). 'close' also
    // resolves so a mid-wait disconnect cannot park this loop forever.
    if (!res.write(chunk) && !res.destroyed) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
  if (requestUnread) req.destroy()
}
