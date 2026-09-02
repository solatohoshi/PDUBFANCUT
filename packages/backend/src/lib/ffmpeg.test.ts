import assert from 'node:assert/strict'
import { buildThumbnailArgs, redactSignedUrls } from './ffmpeg'

const signedUrl = 'https://example.r2.cloudflarestorage.com/video.mp4?X-Amz-Signature=secret&X-Amz-Expires=7200'
const args = buildThumbnailArgs(signedUrl, 242.5, '/tmp/thumbnail-test.jpg')

assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'thumbnail seeking must happen before opening the input')
assert.equal(args[args.indexOf('-ss') + 1], '242.500')
assert.deepEqual(args.slice(args.indexOf('-loglevel'), args.indexOf('-loglevel') + 2), ['-loglevel', 'error'])
assert.ok(args.includes('-frames:v'))
assert.ok(args.includes('-an'))

const redacted = redactSignedUrls(`Command failed for ${signedUrl}`)
assert.ok(!redacted.includes('secret'))
assert.equal(redacted, 'Command failed for https://example.r2.cloudflarestorage.com/video.mp4?<redacted>')

console.log('FFmpeg argument tests passed')
