# PWHL Clip Studio — Project Status

_Last updated: 2026-07-19_

---

## What's built and working

### Backend

| Area | Status | Notes |
|---|---|---|
| Fastify server | ✅ Done | Port 3001, local Postgres via plain `pg` (see below — **not** Neon serverless anymore) |
| Auth (Clerk) | ✅ Done | JWT verification; `DEV_BYPASS_AUTH=true` for local dev |
| Projects API | ✅ Done | CRUD, status tracking, dedup detection |
| Files API | ✅ Done | List/delete source files per project; on-demand filmstrip frame endpoint |
| tus upload | ✅ Done | Resumable uploads; R2 (prod) or local FileStore (dev) |
| Upload validation | ✅ Done | 20 GB cap, MIME + extension allowlist |
| ffprobe metadata | ✅ Done | Duration, codec, resolution populated on upload |
| Clip deduplication | ✅ Done | Reuses analysis when same file is uploaded to a new project |
| BullMQ worker | ✅ Done | Full 7-step pipeline: metadata → chunking → Claude → thumbnails |
| Inline analysis fallback | ✅ Done | Runs Claude directly in upload handler when Redis is unreachable |
| Claude video analysis | ✅ Done | `analyzeVideo.ts` — samples JPEG frames via ffmpeg and sends them as `image` blocks (the Messages API has no native video content type; an earlier version tried a `type: 'video'` block that doesn't exist in the SDK — fixed) |
| Video chunking | ✅ Done | 5-min segments via ffmpeg, offset-corrected timecodes merged |
| Thumbnail generation | ✅ Done | Mid-clip JPEG via ffmpeg, uploaded to R2 or local |
| Filmstrip thumbnails | ✅ Done | Multi-frame on-demand extraction (`/source-files/:id/frame`), grid-rounded + cached, concurrency-limited (max 3 parallel ffmpeg extractions) |
| Export route | ✅ Done | Renders full timeline via ffmpeg — speed/color-adjust per clip, absolute-time text overlays, background music mixing |
| Background music | ✅ Done | Upload (`project_music` table), position/trim on the timeline, volume, ffmpeg `adelay`+`amix` mixing on export |
| Email notifications | ✅ Done | Sends "clips ready" email when analysis completes |
| Redis queue | ⚠️ Environment-dependent | Upstash TLS (port 6380) may be blocked on restrictive networks; inline fallback covers this |

### Frontend

| Area | Status | Notes |
|---|---|---|
| Home page / project list | ✅ Done | Create project, see all projects with status badges |
| Upload flow | ✅ Done | tus resumable upload, progress bar, speed display |
| Project page | ✅ Done | Clip review queue, confirm/dismiss per clip |
| **Multi-track timeline editor** | ✅ Done | Video, text, and music are now three rows in **one shared scrollable container**, same pixels-per-second scale. See "Timeline editor architecture" below. |
| Clip editing | ✅ Done | Drag-reorder, drag-trim in/out, split (both-sides-kept), merge adjacent, speed (0.1–4×), color correction (brightness/contrast/saturation/hue), undo/redo |
| Text overlays | ✅ Done | Drag-to-position, drag-edges-to-resize directly on the timeline (no more dropdowns); 3 styles (title/lower-third/caption); auto-lane-stacks overlapping blocks in the editor |
| Background music | ✅ Done | Drag-to-position, drag-edges-to-trim on the timeline; volume slider; live `<audio>` preview |
| Preview player | ✅ Done | Single active-clip preview (not full sequential playback — see limitations), scrubber, speed, real-time text-overlay compositing |
| Export UI | ✅ Done | Preset picker, progress, download (presigned-URL redirect, not proxied) |
| Error boundary | ✅ Done | Catches React errors, shows fallback UI |
| Clerk auth UI | ✅ Done | Sign-in gate, user session |

---

## Timeline editor architecture (read this before touching `TimelineTrack.tsx`)

This was reworked into a real multi-track editor in the last session. Key files:

- **`packages/frontend/src/components/timeline/TimelineTrack.tsx`** — owns everything: the video row (flex-based, unchanged interaction model) plus new absolutely-positioned TEXT and MUSIC rows sharing the same scrollable container. Also owns the header controls (zoom, "+ Add text" menu, music upload/volume/remove).
- **`packages/frontend/src/components/timeline/CaptionTrack.tsx`** — now just exports the `TextSlot` type + style constants. No component. (Its old dropdown/button UI was deleted.)
- `MusicPanel.tsx` — **deleted**. Its upload/volume/remove controls moved into `TimelineTrack.tsx`'s header.
- **`packages/frontend/src/pages/EditorPage.tsx`** — owns `textSlots`/`musicTrack` state and the callbacks passed into `TimelineTrack`; computes `activeClipAbsoluteStart` (the active clip's cumulative position in the timeline) for both seeding new text at a sensible default position and translating `PreviewPlayer`'s local playhead into the shared absolute-time domain.
- **`packages/frontend/src/components/timeline/PreviewPlayer.tsx`** — filters text overlays by absolute time now (`clipAbsoluteStart + current/speed`), not by clip-id attachment.

**Data model** — both `TextSlot` and the music track now carry an absolute position in the *same* time domain as `effectiveDuration()`/`totalDuration` (i.e., post-trim, post-speed "output timeline" seconds):
- `TextSlot`: `{ startSecs, durationSecs }` — no more `clipId`/dropdown attachment. A block's timeline position *is* its association with whatever clip(s) occupy that span.
- Music (`project_music` table): `{ start_secs, trim_start, trim_end }` — mirrors how video clips are trimmed (drag left edge = trim-in + shift, drag right edge = trim-out, drag body = move).

**Why a piecewise time↔pixel mapping (`buildTimeAxis`/`timeToPx`/`pxToTime` in `TimelineTrack.tsx`)**: video clip blocks are clamped to `MIN_BLOCK_PX` when a clip is short (so it stays draggable at low zoom), which makes pixel position a non-linear function of time. Text/music blocks use this same piecewise mapping so a block dragged to visually align with a clip actually lands on that clip's real time range — a naive `time * pps` would drift out of sync with any clamped-short clip. If you change how video blocks are sized/laid out, update `buildTimeAxis` to match or alignment will silently break.

**Backend mirrors this exactly**: `ffmpeg.ts`'s caption burn-in now just does `enable=between(t, startSecs, startSecs+durationSecs)` per caption directly in the concatenated output's own timeline — no more per-clip lookup. Music is seeked/trimmed precisely (`-ss trimStart -t usedDur`) then shifted into position with `adelay`, replacing an earlier `-stream_loop -1` approach. This was verified end-to-end with a real export: extracted frames confirmed captions appear/disappear at the exact dragged windows, and a 440Hz-bandpass audio analysis confirmed music starts exactly at its dragged position.

---

## Known limitations / good next steps

- **No snap-to-clip-boundary while dragging text/music.** Alignment is pixel-precise but manual — a magnetic snap (e.g. within ~6px of a clip edge) would make "line up with this clip" easier than eyeballing it.
- **No undo/redo for text/music edits.** Video clip edits go through `useTimeline`'s history stack; text/music state lives separately in `EditorPage` and isn't wired into `checkpoint()`/`undo()`/`redo()`.
- **Overlapping same-style captions in the export can visually stack on top of each other.** The editor's lane assignment (`assignLanes` in `TimelineTrack.tsx`) only prevents overlap in the *editor UI*; the export burns each caption in at the same y-position per style, so two simultaneous same-style captions would overlap in the rendered video. Fine for the common case (one caption at a time); would need per-caption vertical offset logic in `ffmpeg.ts` to fully fix.
- **Preview player shows one clip at a time, not full sequential playback.** `PreviewPlayer.tsx` has always worked this way (pre-dates this session) — there's no "play the whole timeline start to finish" scrubber. Worth considering if users want a true full-sequence preview before export.
- **Music block has no waveform visualization** — just a solid colored bar. Would need either client-side Web Audio decoding or a server-generated waveform image.
- **`music.ts` buffers the whole upload in memory** (50 MB cap) rather than streaming — fine for background tracks, would need rework for anything larger.
- **Real (non-stub) export rendering requires R2 configured.** Without `R2_*` env vars, exports fall back to a stub that doesn't actually run ffmpeg. Local dev in this session had R2 configured and real exports were verified working.

---

## Environment quick-reference

```
npm run dev          # starts backend (3001) + frontend (5173) together
npm run worker       # starts BullMQ worker separately (needs Redis)
npm run migrate -w packages/backend   # applies packages/backend/src/db/schema.sql (idempotent)

# .env must-haves
DATABASE_URL         # plain Postgres connection string — this project now uses
                      # the `pg` driver, NOT @neondatabase/serverless. Local dev
                      # runs Postgres via `docker-compose.yml` on port 5433
                      # (5432 was already taken by something else on this machine —
                      # change it back if that's no longer true in your environment).
REDIS_URL             # rediss://...upstash.io:6380  (port 6380, no quotes)
ANTHROPIC_API_KEY     # for Claude analysis
FFMPEG_PATH           # full path to ffmpeg binary
FFPROBE_PATH          # full path to ffprobe binary

# R2 (optional for dev — comment out to use local FileStore + stub exports)
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
```

**If you add/change DB schema:** edit `packages/backend/src/db/schema.sql` using the existing idempotent `DO $$ ... ALTER TABLE IF NOT EXISTS ... $$` pattern (see `project_music`'s `start_secs`/`trim_start`/`trim_end` columns for a recent example), then run `npm run migrate -w packages/backend`.

---

## Known issues / next steps (carried over, still open)

- [ ] **R2 credentials** — confirm the bucket exists and the API token has write permission if deploying somewhere new.
- [ ] **Worker Redis** — test `npm run worker`; should show `✓ Redis` in the startup health check.
- [ ] **Training data table** — `training_examples` schema table not yet added (see `AI_Pipeline_Plan.md`).
- [ ] **Eval harness** — script to measure precision/recall per scene category (see plan).
- [ ] **PWHL roster JSON** — jersey → player name mapping for current season (manual).

---

## AI pipeline plan

See [AI_Pipeline_Plan.md](AI_Pipeline_Plan.md) for the full plan: Claude multimodal now, custom ML models later as training data accumulates from the review queue.
