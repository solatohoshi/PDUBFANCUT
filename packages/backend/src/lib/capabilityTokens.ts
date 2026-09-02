import { createHmac, timingSafeEqual } from 'node:crypto'

export type CapabilityScope = 'upload' | 'media'

export interface CapabilityClaims {
  sub: string
  projectId: string
  scope: CapabilityScope
  iat: number
  exp: number
}

const MAX_TTL_SECS: Record<CapabilityScope, number> = {
  upload: 60 * 60,
  media: 4 * 60 * 60,
}

function secret(): string {
  const configured = process.env.CAPABILITY_TOKEN_SECRET
  if (configured && configured.length >= 32) return configured

  if (process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS_AUTH === 'true') {
    return 'pdubfancut-development-capability-secret'
  }

  throw new Error('CAPABILITY_TOKEN_SECRET must be configured with at least 32 characters')
}

export function validateCapabilityTokenConfig(): void {
  void secret()
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signature(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url')
}

export function createCapabilityToken(
  claims: Omit<CapabilityClaims, 'iat' | 'exp'>,
  ttlSecs: number,
): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000)
  const boundedTtl = Math.min(MAX_TTL_SECS[claims.scope], Math.max(30, ttlSecs))
  const payload: CapabilityClaims = {
    ...claims,
    iat: now,
    exp: now + boundedTtl,
  }
  const body = encode(payload)
  return {
    token: `${body}.${signature(body)}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  }
}

export function verifyCapabilityToken(token: string, scope: CapabilityScope): CapabilityClaims {
  const [body, suppliedSignature, extra] = token.split('.')
  if (!body || !suppliedSignature || extra) throw new Error('Malformed capability token')

  const expected = Buffer.from(signature(body))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('Invalid capability token')
  }

  let claims: CapabilityClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CapabilityClaims
  } catch {
    throw new Error('Malformed capability token payload')
  }

  if (claims.scope !== scope || !claims.sub || !claims.projectId) {
    throw new Error('Capability token has the wrong scope')
  }
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)
    || claims.iat > now + 60 || claims.exp <= claims.iat
    || claims.exp - claims.iat > MAX_TTL_SECS[scope]) {
    throw new Error('Capability token has invalid timing claims')
  }
  if (claims.exp <= now) {
    throw new Error('Capability token has expired')
  }
  return claims
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const [scheme, token] = value.trim().split(/\s+/, 2)
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}
