/** Client-source-IP allowlist: entry parsing and matching. */
import { describe, expect, it } from 'vitest'
import {
  isClientIpAllowed,
  parseClientIpAllowlistEntry,
} from '../src/client-ip-allowlist.ts'

describe('client-ip-allowlist', () => {
  it('parses exact addresses into full-length prefixes', () => {
    expect(parseClientIpAllowlistEntry('100.75.247.91'))
      .toEqual({ family: 4, value: 0x644bf75bn, prefix: 32 })
    expect(parseClientIpAllowlistEntry('127.0.0.1'))
      .toEqual({ family: 4, value: 0x7f000001n, prefix: 32 })
    expect(parseClientIpAllowlistEntry('::1'))
      .toEqual({ family: 6, value: 1n, prefix: 128 })
    expect(parseClientIpAllowlistEntry('fd00::42'))
      .toEqual({ family: 6, value: (0xfd00n << 112n) | 0x42n, prefix: 128 })
  })

  it('parses CIDR entries and keeps the declared prefix', () => {
    expect(parseClientIpAllowlistEntry('100.64.0.0/10'))
      .toEqual({ family: 4, value: 0x64400000n, prefix: 10 })
    expect(parseClientIpAllowlistEntry('192.168.1.0/24'))
      .toEqual({ family: 4, value: 0xc0a80100n, prefix: 24 })
    expect(parseClientIpAllowlistEntry('fd00::/8'))
      .toEqual({ family: 6, value: 0xfd00n << 112n, prefix: 8 })
    expect(parseClientIpAllowlistEntry('100.64.0.0/0'))
      .toEqual({ family: 4, value: 0x64400000n, prefix: 0 })
  })

  it('fails loudly on malformed entries', () => {
    expect(() => parseClientIpAllowlistEntry('not-an-ip')).toThrow(/not a valid IPv4 or IPv6/)
    expect(() => parseClientIpAllowlistEntry('10.0.0/8')).toThrow(/not a valid IPv4 or IPv6/)
    expect(() => parseClientIpAllowlistEntry('10.0.0.256/8')).toThrow(/not a valid IPv4 or IPv6/)
    expect(() => parseClientIpAllowlistEntry('10.0.0.0/33')).toThrow(/exceeds the 32-bit prefix/)
    // A prefix beyond the widest family is caught by the general validity check.
    expect(() => parseClientIpAllowlistEntry('::1/129')).toThrow(/not a valid CIDR prefix/)
    expect(() => parseClientIpAllowlistEntry('10.0.0.0/')).toThrow(/not a valid CIDR prefix/)
    expect(() => parseClientIpAllowlistEntry('10.0.0.0/-1')).toThrow(/not a valid CIDR prefix/)
  })

  it('matches IPv4 sources against exact and CIDR entries', () => {
    const exact = [parseClientIpAllowlistEntry('100.75.247.91')]
    expect(isClientIpAllowed('100.75.247.91', exact)).toBe(true)
    expect(isClientIpAllowed('100.75.247.92', exact)).toBe(false)

    const tail = [parseClientIpAllowlistEntry('100.64.0.0/10')]
    // 100.64.0.0/10 spans 100.64.0.0 through 100.127.255.255.
    expect(isClientIpAllowed('100.75.247.91', tail)).toBe(true)
    expect(isClientIpAllowed('100.121.71.79', tail)).toBe(true)
    expect(isClientIpAllowed('100.127.255.255', tail)).toBe(true)
    expect(isClientIpAllowed('100.128.0.0', tail)).toBe(false)
    expect(isClientIpAllowed('192.168.1.50', tail)).toBe(false)

    const open = [parseClientIpAllowlistEntry('100.64.0.0/0')]
    expect(isClientIpAllowed('8.8.8.8', open)).toBe(true)
  })

  it('matches IPv4-mapped sources against dotted-quad entries', () => {
    const exact = [parseClientIpAllowlistEntry('100.75.247.91')]
    expect(isClientIpAllowed('::ffff:100.75.247.91', exact)).toBe(true)
    expect(isClientIpAllowed('::ffff:100.75.247.92', exact)).toBe(false)
  })

  it('matches IPv6 sources against exact and CIDR entries', () => {
    const ula = [parseClientIpAllowlistEntry('fd00::/8')]
    expect(isClientIpAllowed('fd00:1234::1', ula)).toBe(true)
    // /8 pins the first byte (0xfd); fc00::1's first byte (0xfc) is outside.
    expect(isClientIpAllowed('fc00::1', ula)).toBe(false)
    // A plain v6 entry never matches an IPv4-mapped source, and vice versa.
    const loop = [parseClientIpAllowlistEntry('::1')]
    expect(isClientIpAllowed('127.0.0.1', loop)).toBe(false)
    expect(isClientIpAllowed('::1', [parseClientIpAllowlistEntry('127.0.0.1')])).toBe(false)
  })

  it('matches nothing for missing addresses, unparseable sources, or an empty list', () => {
    const exact = [parseClientIpAllowlistEntry('100.75.247.91')]
    expect(isClientIpAllowed(undefined, exact)).toBe(false)
    expect(isClientIpAllowed('fe80::1%eth0', [parseClientIpAllowlistEntry('fe80::/10')])).toBe(false)
    expect(isClientIpAllowed('100.75.247.91', [])).toBe(false)
  })
})
