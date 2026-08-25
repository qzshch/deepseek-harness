import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'host.pickDirectory', payload: {},
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/host.pickDirectory',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })
})

describe('HTTP bridge gzip', () => {
  const largePayload = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(200) })) })
  const smallPayload = JSON.stringify({ ok: true })

  function makeRequest(acceptEncoding?: string): IncomingMessage {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding }) },
    })
    return request
  }

  function makeResponse(): { response: ServerResponse; state: { status: number; headers: Record<string, string>; body: Buffer } } {
    const state = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) }
    const chunks: Buffer[] = []
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values: Record<string, string>) { state.status = code; state.headers = values; return this },
      write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); return true },
      end(chunk?: Buffer) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        state.body = Buffer.concat(chunks)
        this.writableEnded = true
        return this
      },
    }) as unknown as ServerResponse
    return { response, state }
  }

  it('gzip-compresses a large JSON response for a gzip client', async () => {
    const { response, state } = makeResponse()
    await bridge(makeRequest('gzip'), response, { fetch: async () => Response.json(JSON.parse(largePayload)) }, 1e9)
    expect(state.status).toBe(200)
    expect(state.headers['content-encoding']).toBe('gzip')
    expect(state.headers.vary).toContain('Accept-Encoding')
    expect(JSON.parse(gunzipSync(state.body).toString('utf8'))).toEqual(JSON.parse(largePayload))
  })

  it('leaves large responses untouched for a non-gzip client', async () => {
    const { response, state } = makeResponse()
    await bridge(makeRequest(), response, { fetch: async () => Response.json(JSON.parse(largePayload)) }, 1e9)
    expect(state.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(state.body.toString('utf8'))).toEqual(JSON.parse(largePayload))
  })

  it('skips gzip for tiny bodies even when advertised', async () => {
    const { response, state } = makeResponse()
    await bridge(makeRequest('gzip'), response, { fetch: async () => Response.json(JSON.parse(smallPayload)) }, 1e9)
    expect(state.headers['content-encoding']).toBeUndefined()
  })
})
