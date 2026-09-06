/**
 * Client-source-IP allowlist for the browser-auth bypass. Entries are exact
 * IPv4/IPv6 addresses or CIDR ranges; a matching TCP source address skips the
 * launch-token/cookie authentication while the Host/Origin and cross-site
 * fences still apply to its requests.
 */

/** Parsed allowlist entry: one address family with a prefix length. */
export interface ClientIpAllowlistEntry {
  /** 4 for IPv4 (covers dotted-quad and IPv4-mapped forms), 6 for IPv6. */
  readonly family: 4 | 6
  /** Numeric address in its family space (32-bit for v4, 128-bit for v6). */
  readonly value: bigint
  /** Prefix length in bits (32 for an exact IPv4 address, 128 for an exact IPv6). */
  readonly prefix: number
}

const V4_SPACE_BITS = 32
const V6_SPACE_BITS = 128
const V4_MASK_FULL = (1n << 32n) - 1n
const V6_MASK_FULL = (1n << 128n) - 1n

/** 32-bit value of a dotted-quad IPv4 literal, or undefined. */
function ipv4Bits(addr: string): bigint | undefined {
  const parts = addr.split('.')
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined
    value = (value << 8n) | BigInt(Number(part))
  }
  return value
}

/** The eight 16-bit groups of an IPv6 literal (a single `::` run expanded), or undefined. */
function ipv6Groups(addr: string): string[] | undefined {
  let head = addr
  let tail = ''
  let hasDoubleColon = false
  if (addr.includes('::')) {
    hasDoubleColon = true
    const at = addr.indexOf('::')
    head = addr.slice(0, at)
    tail = addr.slice(at + 2)
    if (tail.includes('::')) return undefined
  }
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  for (const group of [...headGroups, ...tailGroups]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
  }
  if (!hasDoubleColon) return headGroups.length === 8 ? [...headGroups] : undefined
  const missing = 8 - headGroups.length - tailGroups.length
  if (missing < 1) return undefined
  return [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups]
}

/** 128-bit value of a plain IPv6 literal, or undefined. */
function ipv6Bits(addr: string): bigint | undefined {
  const groups = ipv6Groups(addr)
  if (groups === undefined) return undefined
  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16))
  return value
}

/**
 * Numeric value of an address in its own family space. IPv4-mapped IPv6
 * sources (`::ffff:a.b.c.d`) classify as IPv4 so a dotted-quad allowlist
 * covers both spellings node may report.
 */
function addressBits(raw: string): { family: 4 | 6; value: bigint } | undefined {
  const addr = raw.trim()
  if (addr.toLowerCase().startsWith('::ffff:')) {
    const mapped = ipv4Bits(addr.slice(7))
    if (mapped !== undefined) return { family: 4, value: mapped }
  }
  const v4 = ipv4Bits(addr)
  if (v4 !== undefined) return { family: 4, value: v4 }
  const v6 = ipv6Bits(addr)
  if (v6 !== undefined) return { family: 6, value: v6 }
  return undefined
}

/**
 * Parse one allowlist entry (exact IP or CIDR), failing the load loudly on a
 * malformed entry. IPv4 entries match dotted-quad and IPv4-mapped source
 * addresses; IPv6 entries match plain IPv6 sources only.
 * @param entry - configured entry, e.g. `100.75.247.91` or `100.64.0.0/10`.
 * @returns the entry parsed into its family space and prefix length.
 */
export function parseClientIpAllowlistEntry(entry: string): ClientIpAllowlistEntry {
  const raw = entry.trim()
  let addressPart = raw
  let prefix: number | undefined
  const separator = raw.lastIndexOf('/')
  if (separator !== -1) {
    addressPart = raw.slice(0, separator)
    const prefixPart = raw.slice(separator + 1)
    if (!/^\d{1,3}$/.test(prefixPart) || Number(prefixPart) > 128) {
      throw new Error(
        `client-connection: trustedClientIps entry ${JSON.stringify(entry)} is not a valid CIDR prefix`,
      )
    }
    prefix = Number(prefixPart)
  }
  const bits = addressBits(addressPart)
  if (bits === undefined) {
    throw new Error(
      `client-connection: trustedClientIps entry ${JSON.stringify(entry)} is not a valid IPv4 or IPv6 address`,
    )
  }
  const maxPrefix = bits.family === 4 ? V4_SPACE_BITS : V6_SPACE_BITS
  if (prefix !== undefined && prefix > maxPrefix) {
    throw new Error(
      `client-connection: trustedClientIps entry ${JSON.stringify(entry)} exceeds the ${String(maxPrefix)}-bit prefix of its address family`,
    )
  }
  return { family: bits.family, value: bits.value, prefix: prefix ?? maxPrefix }
}

/**
 * Whether a TCP source address is covered by any parsed allowlist entry.
 * @param remoteAddress - node http socket remote address (dotted-quad, plain IPv6, or IPv4-mapped form).
 * @param entries - parsed allowlist entries (an empty list matches nothing).
 * @returns true only when the address parses and matches an entry of the same family.
 */
export function isClientIpAllowed(
  remoteAddress: string | undefined,
  entries: readonly ClientIpAllowlistEntry[],
): boolean {
  if (remoteAddress === undefined || entries.length === 0) return false
  const bits = addressBits(remoteAddress)
  if (bits === undefined) return false
  for (const entry of entries) {
    if (entry.family !== bits.family) continue
    const space = entry.family === 4 ? 32n : 128n
    const full = entry.family === 4 ? V4_MASK_FULL : V6_MASK_FULL
    // A CIDR prefix pins the HIGH bits: shift the full mask right to size it,
    // then back left to keep it anchored at the top of the family space.
    const shift = space - BigInt(entry.prefix)
    const mask = entry.prefix === 0 ? 0n : (full >> shift) << shift
    if ((bits.value & mask) === (entry.value & mask)) return true
  }
  return false
}
