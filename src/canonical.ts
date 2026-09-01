/** Deterministic JSON encoding and domain-separated semantic digests. */

import { createHash } from 'node:crypto'

/** Canonical JSON value accepted by the v2 digest protocol. */
export type CanonicalJsonValue = null | boolean | number | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

/** Normalize one value into a recursively key-sorted JSON value. */
function normalize(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} must contain only finite JSON numbers and cannot contain -0`)
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`))
  if (typeof value !== 'object') throw new TypeError(`${path} is not JSON-serializable`)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`)
  }
  const record = value as Record<string, unknown>
  const normalized: Record<string, CanonicalJsonValue> = {}
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) throw new TypeError(`${path}.${key} cannot be undefined`)
    normalized[key] = normalize(record[key], `${path}.${key}`)
  }
  return normalized
}

/**
 * Encode a JSON-compatible value with recursively sorted object keys.
 *
 * @param value Value to encode.
 * @returns Deterministic JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, 'value'))
}

/**
 * Hash a canonical value under an explicit semantic object domain.
 *
 * @param domain Stable object domain such as `spec` or `candidate`.
 * @param version Canonical protocol version for the domain.
 * @param value Value to identify.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
export function semanticDigest(domain: string, version: number, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(domain)) throw new TypeError('semantic digest domain must be lower-kebab-case')
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('semantic digest version must be a positive safe integer')
  return createHash('sha256')
    .update(`dsh-semantic-${domain}/v${version}\0`)
    .update(canonicalJson(value))
    .digest('hex')
}

/** Test whether a value is a lowercase SHA-256 digest, with an optional `sha256:` prefix. */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value)
}
