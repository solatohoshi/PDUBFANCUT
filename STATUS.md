# PWHL Clip Studio — Project Status

_Last updated: 2026-07-09_

---

## What's built and working

### Backend

| Area | Status | Notes |
|---|---|---|
| Fastify server | ✅ Done | Port 3001, Neon Postgres via WebSocket |
| Auth (Clerk) | ✅ Done | JWT verification; `DEV_BYPASS_AUTH=true` for local dev |
| Projects API | ✅ Done | CRUD, status tracking, dedup detection |
| Files API | ✅ Done | List/delete source files per project |
| tus upload | ✅ Done | Resumable uploads; R2 (prod) or local FileStore (dev) |
| Upload validation | ✅ Done | 20 GB cap, MIME + extension allowlist |
| ffprobe metadata | ✅ Done | Duration, codec, resolution populated on upload |
| Clip deduplication | ✅ Done | Reuses analysis when same file is uploaded to a new project |
| BullMQ worker | ✅ Done | Full 7-step pipeline: metadata → chunking → Claude → thumbnails |
| Inline analysis fallback | ✅ Done | Runs Claude directly in upload handler when Redis is unreachable |
| Claude video analysis | ✅ Done | `analyzeVideo.ts` — Claude Opus multimodal, `report_clips` tool |
| Video chunking | ✅ Done | 5-min segments via ffmpeg, offset-corrected timecodes merged |
| Thumbnail generation | ✅ Done | Mid-clip JPEG via ffmpeg, uploaded to R2 or local |
| Export route | ✅ Done | Renders timeline via ffmpeg, returns MP4 |
| Email notifications | ✅ Done | Sends "clips ready" email when analysis completes |
| Redis queue | ⚠️ Needs home network | Upstash TLS (port 6380) blocked on school network |

### Frontend

| Area | Status | Notes |
|---|---|---|
| Home page / project list | ✅ Done | Create project, see all projects with status badges |
| Upload flow | ✅ Done | tus resumable upload, progress bar, speed display |
| Project page | ✅ Done | Clip review queue, confirm/dismiss per clip |
| Timeline editor | ✅ Done | Drag clips, trim in/out, reorder tracks |
| Preview player | ✅ Done | Scrubber, speed control, SVG thumbnails |
| Export UI | ✅ Done | Trigger export, download result |
| Error boundary | ✅ Done | Catches React errors, shows fallback UI |
| Clerk auth UI | ✅ Done | Sign-in gate, user session |

---

## What needs to be tested at home

- **Upload end-to-end** — school network blocks tus long-lived PATCH connections and Upstash Redis (port 6380). Everything should work on a normal connection.
- **BullMQ worker** — run `npm run worker` separately; health check prints Redis/Postgres/ffmpeg/Anthropic status on startup.
- **R2 storage** — re-enable by uncommenting R2 vars in `.env`. Currently using local FileStore for dev.
- **Claude analysis** — inline fallback runs when worker is unavailable; worker does chunked analysis for long videos.

---

## Known issues / next steps

- [ ] **R2 credentials** — confirm the bucket `pdubfancut-uploads` exists in the Cloudflare dashboard and the API token has R2 write permission.
- [ ] **Worker Redis** — test `npm run worker` at home; should show `✓ Redis` in the startup health check.
- [ ] **End-to-end upload test** — upload a short video (<100 MB), confirm project reaches `ready` status and clips appear.
- [ ] **Training data table** — `training_examples` schema table not yet added (see `AI_Pipeline_Plan.md`).
- [ ] **Eval harness** — script to measure precision/recall per scene category (see plan).
- [ ] **PWHL roster JSON** — jersey → player name mapping for current season (manual).

---

## Environment quick-reference

```
npm run dev          # starts backend (3001) + frontend (5173) together
npm run worker       # starts BullMQ worker separately (needs Redis)

# .env must-haves
DATABASE_URL         # Neon Postgres connection string
REDIS_URL            # rediss://...upstash.io:6380  (port 6380, no quotes)
ANTHROPIC_API_KEY    # for Claude analysis
FFMPEG_PATH          # full path to ffmpeg.exe (WinGet install)
FFPROBE_PATH         # full path to ffprobe.exe

# R2 (optional for dev — comment out to use local FileStore)
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
```

---

## AI pipeline plan

See [AI_Pipeline_Plan.md](AI_Pipeline_Plan.md) for the full plan: Claude multimodal now, custom ML models later as training data accumulates from the review queue.
