import assert from 'node:assert/strict'
import { bearerToken, createCapabilityToken, verifyCapabilityToken } from './capabilityTokens'

process.env.CAPABILITY_TOKEN_SECRET = 'test-only-capability-secret-0123456789'

const realNow = Date.now
const issuedAt = realNow()
Date.now = () => issuedAt
const upload = createCapabilityToken(
  { sub: 'user_test', projectId: 'project_test', scope: 'upload' },
  60,
)
Date.now = realNow

assert.deepEqual(
  verifyCapabilityToken(upload.token, 'upload'),
  {
    sub: 'user_test',
    projectId: 'project_test',
    scope: 'upload',
    iat: Math.floor(issuedAt / 1000),
    exp: Math.floor(issuedAt / 1000) + 60,
  },
)
assert.throws(() => verifyCapabilityToken(upload.token, 'media'), /wrong scope/)

const [body, signature] = upload.token.split('.')
assert.throws(
  () => verifyCapabilityToken(`${body}x.${signature}`, 'upload'),
  /Invalid capability token/,
)

try {
  Date.now = () => issuedAt + 61_000
  assert.throws(() => verifyCapabilityToken(upload.token, 'upload'), /expired/)
} finally {
  Date.now = realNow
}

assert.equal(bearerToken(`Bearer ${upload.token}`), upload.token)
assert.equal(bearerToken('Basic abc'), null)
assert.equal(bearerToken(undefined), null)

Date.now = () => issuedAt
const bounded = createCapabilityToken(
  { sub: 'user_test', projectId: 'project_test', scope: 'upload' },
  24 * 60 * 60,
)
Date.now = realNow
assert.equal(
  verifyCapabilityToken(bounded.token, 'upload').exp,
  Math.floor(issuedAt / 1000) + 60 * 60,
)

console.log('Capability token tests passed')
