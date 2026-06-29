# PWHL Clip Studio — Executable Product Plan

**Scope:** File-upload-only, fan-facing video editing app  
**Goal:** Help PWHL fans find, trim, and export hockey moments faster than a general editor  
**Version:** 1.0 plan — updated to file upload only, Claude Code-assisted development timeline

---

## What you're building

A domain-specific video editor where the AI does the scouting work first — detecting goals, saves, hits, and other moments in uploaded footage — then hands the user a CapCut-style canvas to finish the story.

The workflow in one sentence: **upload a file → choose analysis mode → AI processes in the background → browse and select clips → edit on a timeline → export to social.**

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 — Video ingest (file upload only)                  │
│  MP4 · MOV · MXF · AVI  |  max 20 GB per file             │
└───────────────────┬─────────────────────────────────────────┘
                    │ raw video
┌───────────────────▼─────────────────────────────────────────┐
│  Layer 2 — AI recognition pipeline (async, GPU)             │
│                                                             │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────┐  │
│  │ Player detection │ │ Scene classifier │ │ Puck track │  │
│  │ Jersey #, face   │ │ Goal,save,hit,   │ │ Position + │  │
│  │ silhouette       │ │ shot,scrum,celeb │ │ velocity   │  │
│  └──────────────────┘ └──────────────────┘ └────────────┘  │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────┐  │
│  │ Boundary detect  │ │ Audio analysis   │ │ Confidence │  │
│  │ Smart in/out pts │ │ Horn,whistle,    │ │ scoring +  │  │
│  │                  │ │ crowd roar       │ │ review que │  │
│  └──────────────────┘ └──────────────────┘ └────────────┘  │
│                                                             │
│  Clip metadata store                                        │
│  Timecodes · player tags · scene label · confidence · thumb │
└───────────────────┬─────────────────────────────────────────┘
                    │ tagged clips
┌───────────────────▼─────────────────────────────────────────┐
│  Layer 3 — Editor surface                                   │
│                                                             │
│  Smart clip browser → Multi-track timeline → Preview player │
│                                                             │
│  Tools: Trim · Sound · Text · Effects · Filters             │
│                                                             │
│  Export: H.264/HEVC · 720p–4K · Reels, TikTok, X, download │
└─────────────────────────────────────────────────────────────┘
```

---

## Ingest — what's in and what's out

### In scope (v1)
- **Direct file upload** — MP4, MOV, MXF, AVI; up to 20 GB per file
- **Google Drive / Dropbox import** — link to an existing file the user already owns (no scraping, no stream capture)
- Drag-and-drop upload in browser; resumable upload for large files (tus protocol)
- Upload progress indicator with estimated processing time

### Analysis mode selection

Presented to the user immediately after the file is confirmed (while it uploads in the background). Two modes, both landing in the same clip browser once complete:

**Full analysis** *(default)*
- Pipeline tags every detectable moment in the entire file
- User gets a notification when ready, then explores the full clip browser freely
- Best for: first-time users, discovery, full-game review
- Cost: higher compute per file; mitigated by result caching — if the same game file hash is uploaded again by any user, tags are reused without reprocessing

**Quick search**
- User specifies one or more players (by jersey number or name) and/or scene types before processing starts
- Pipeline only analyses the requested segments, skipping the rest
- Best for: power users who know exactly what they want ("just #18 hits from this game")
- Warning shown at selection: *"You can run additional searches later, but each one requires extra processing time"*
- User can promote a Quick search project to Full analysis at any time from the clip browser

Both modes run fully in the background — the user does not wait at an upload screen. They are notified by email and in-app when clips are ready.

### Explicitly out of scope
- Live stream ingest (RTMP/HLS) — requires broadcaster rights not available to fans
- Broadcast API access (ESPN+, TSN) — requires formal licensing deal with league/broadcaster
- Screen recording capture tooling — legally ambiguous, not supported
- YouTube URL import — removed due to ToS conflicts

> **Why:** The realistic fan workflow is working with files they already have — downloaded VODs they own, clips shared by other fans, or footage shot at games. File upload covers 95%+ of real use cases without the legal and technical complexity of live ingest.

---

## Phase 1 — Foundation (weeks 1–4)

> Claude Code impact: scaffolding, API routes, DB schema, upload endpoint, and job queue wiring that would normally take 6–8 weeks can be done in 2–3 weeks. Boilerplate is essentially free.

### Goals
- File upload pipeline working end-to-end
- Basic AI detection running on a test corpus
- Internal demo with 5 real PWHL game files

### Tech stack

| Component | Choice | Rationale |
|---|---|---|
| Frontend | React + Remotion | Remotion renders compositions in code; unified stack for preview and export |
| Backend API | Node.js + Fastify | Fast, low-overhead, good streaming support for upload progress |
| Job queue | BullMQ on Redis | Async AI jobs; retry logic built in |
| Object storage | AWS S3 | Raw video files + processed clips + thumbnails |
| Database | PostgreSQL | Clip metadata, user data, job state |
| GPU inference | Modal or RunPod | Spin up per-job; keeps cost variable at low volume |
| Auth | Clerk or Auth0 | Fast to ship; handles email + social login |

### Key deliverables
- [ ] Resumable upload endpoint (tus server) with S3 multipart backend
- [ ] Upload UI: drag-and-drop zone, progress bar, estimated time
- [ ] Analysis mode selection UI: Full analysis (default) vs Quick search with player/scene inputs
- [ ] Job dispatcher: on upload complete, enqueue AI pipeline job with mode parameters
- [ ] File hash deduplication: reuse existing tag results if the same game file was previously analysed

---

## Phase 2 — AI recognition pipeline (weeks 4–12)

> Claude Code impact: inference API, pipeline orchestration, and eval harness are fast to write. The bottleneck remains data labelling (500–1,000 clips per scene category) and training iteration — those are human and compute time that don't compress. Budget 6–8 weeks of calendar time here regardless of coding speed.

### How it works

The pipeline runs as an async GPU job after upload completes — always in the background, never blocking the user. The steps that run depend on the analysis mode chosen at upload. This includes recognising team jersey colours — each PWHL team has a distinct home/away colour palette, and colour is one of the most reliable signals available (works even when a player is partially occluded or facing away, before any number OCR is attempted).

**In Full analysis mode:** all 7 steps run across the entire file.  
**In Quick search mode:** steps 1–3 are scoped to the requested players/scenes only; steps 4–7 run only on matched segments.

Sequence:

1. **Frame sampling** — extract 1 frame/sec for scene classification; 30 fps only in detected event windows for boundary detection
2. **Team colour recognition** — classify each detected player silhouette by jersey colour using the PWHL team palette (e.g. Boston red, Minnesota green, Toronto blue); runs before number OCR as a fast first pass to separate teams and filter clips by side
3. **Player detection** — YOLOv8 fine-tuned on PWHL footage (bounding box + silhouette only — no face recognition; helmets and visors make it impractical in hockey); player identity resolved via jersey number OCR matched against a per-team roster lookup (`home #13 → Emerance Maschmeyer`)
4. **Scene classification** — VideoMAE or InternVideo2; label each 2-second window with up to 3 scene tags and a confidence score; categories: `goal`, `save`, `shot_on_goal`, `hit`, `scrum`, `celebration`, `penalty`, `faceoff`
5. **Audio event detection** — lightweight CNN for goal horn, referee whistle, crowd roar onset; fast first pass before heavier vision models
6. **Boundary detection** — given a confirmed event, walk ±5 seconds to find natural in/out points (e.g., the moment a player winds up, not just contact)
7. **Clip packaging** — write timecodes + all tags to metadata store; generate a 1-second GIF thumbnail per clip

### Confidence and review queue
- Clips ≥ 85% confidence → auto-published to the clip browser
- Clips 60–84% → surfaced in a review queue; user makes one-tap confirm/dismiss
- Clips < 60% → discarded silently (logged for model improvement)
- Every user correction is written back as a labelled training example

### Training data requirements

| Scene category | Labelled clips needed for 85%+ accuracy |
|---|---|
| Goal | 800–1,000 |
| Save | 600–800 |
| Hit | 700–900 |
| Shot on goal | 500–700 |
| Scrum / celebration | 400–600 each |

Start by labelling 20 full PWHL game files manually. Use the review queue to scale labelling from day one of beta.

### Key risks

**Jersey number OCR under broadcast conditions** — motion blur, low-contrast jerseys, partial occlusion.  
Mitigation: train on PWHL-specific jersey colours and fonts; use multi-frame averaging (if the number reads cleanly in any 5 frames in a 30-frame window, commit); always allow user correction.

**Scene confusion at boundaries** — a save that turns into a rebound shot is two events.  
Mitigation: allow multi-label per window; user can split or merge clips manually.

### Phase 2 deliverables
- [ ] File validation: codec check, duration cap, virus scan (runs at pipeline start before GPU job is enqueued)

---

## Phase 3 — Editor surface (weeks 10–16)

> Claude Code impact: this is where the biggest time saving occurs. React components, timeline state management, filter panels, and effect controls that would take 10 weeks can be built in 4–6 weeks. Claude Code is strong on UI composition and Remotion integration.

### Clip browser
- Filterable grid of all detected clips for a project
- Filters: player name, jersey number, scene type, game date, confidence threshold
- Sort by: time in game, scene type, player
- Multi-select to batch-add to timeline
- One-click "add all goals" or "add all [player name] clips" presets
- **Mode indicator banner** — if the project was processed in Quick search mode, a persistent banner shows what was searched and offers a one-click "Run full analysis" upgrade
- **Add search** — in Quick search projects, user can add a new player or scene type and trigger a targeted re-run without reprocessing already-analysed segments

### Timeline
Multi-track, frame-accurate, non-destructive.

| Track | Features |
|---|---|
| Video | Trim handles, split, ripple delete, speed (0.25×, 0.5×, 1×, 2×) |
| Audio | Waveform scrub, volume envelope, mute/solo |
| Music | Background track with auto-duck on original audio |
| Text | Captions, titles, lower-thirds; player name lower-third as one-click insert |
| Effects | Slow-mo, freeze frame, Ken Burns pan/zoom |
| Filters | LUT presets, colour temperature, vignette |

### v1 editing feature set (CapCut parity)
- Cut and split
- Slow motion (0.25×, 0.5×)
- Freeze frame
- Ken Burns pan/zoom
- 15 social-ratio presets (9:16, 1:1, 16:9, 4:5)
- Text templates (score bug, player name, game date)
- Basic LUT filters (10 presets)
- Crowd-noise bed + arena intro music packs (royalty-free)
- Transition: cut and cross-dissolve only in v1

### Out of scope for v1
- Advanced colour grading (curves, scopes)
- Multi-cam sync
- AI-generated captions / speech-to-text
- Collaborative editing
- Motion tracking for text

### Phase 3 deliverables
- [ ] Basic project model: user → project → source files → analysis mode → clips
- [ ] Background notification system: email + in-app alert when clips are ready

---

## Phase 4 — Export and share (weeks 14–18)

> Claude Code impact: FFmpeg pipeline configuration and share flow are well within Claude Code's strengths — expect this phase to take roughly half the time of a manual implementation.

Render in the cloud (FFmpeg on a GPU worker), not on-device. This keeps the browser lightweight and handles large files without client hardware constraints.

### Export presets

| Preset | Resolution | Format | Max duration |
|---|---|---|---|
| TikTok / Reels | 1080×1920 (9:16) | H.264 | 60s |
| X / Twitter | 1920×1080 (16:9) | H.264 | 140s |
| Instagram square | 1080×1080 (1:1) | H.264 | 60s |
| Full res download | up to 4K | H.264 or HEVC | unlimited |

### Share flow
- Render progress bar with estimated time
- One-tap share sheet: pre-filled caption with player name, scene type, game date, and PWHL hashtags
- Direct download link (expires after 7 days; user can re-render)
- Copy shareable link (public, watermarked in free tier)

---

## Build order recommendation

Build the AI pipeline first, as a standalone API with no editor UI. The goal: reach >85% detection precision on a test corpus of 20 PWHL games **before** touching the editor. This lets you validate the core value prop (AI moment detection) by week 7, not week 24.

With Claude Code-assisted development the total timeline compresses from 24 weeks to **14–16 weeks**. Coding phases shrink significantly; the AI training iteration loop (Phase 2) is the only phase that doesn't compress — it's gated on data labelling and GPU training runs, not on writing speed.

```
Week 1–2   Upload pipeline + S3 storage + job queue          (Claude Code: fast)
Week 3–4   Player detection + scene classifier (first pass)  (Claude Code: fast)
Week 5–10  Detection quality iteration + data labelling      (human-gated, fixed)
Week 11–12 Boundary detection + audio events + clip browser  (Claude Code: fast)
Week 11–14 Timeline v1: trim, cut, basic audio               (Claude Code: fast)
Week 13–16 Effects, filters, text, music                     (Claude Code: fast)
Week 15–18 Export pipeline + share flow + beta launch        (Claude Code: fast)
```

> Phases 3 and 4 overlap intentionally — the editor UI can be built in parallel once the clip metadata API is stable, even if detection quality is still being tuned.

---

## What to defer to v2

- Live stream ingest (if a league partnership is established)
- Broadcast API integration (PWHL digital team partnership required)
- AI-generated highlight reels (auto-assemble a "best of game" reel)
- Speech-to-text captions
- Multi-cam sync
- Collaborative projects
- Mobile native app (v1 is browser-only, mobile-responsive)

---

## Success metrics for v1 launch

| Metric | Target |
|---|---|
| AI detection precision (goal/save/hit) | ≥ 85% |
| Time from upload to first clip in browser | ≤ 5 min for a 3-hour game file |
| Export render time | ≤ 2× clip duration |
| User review queue dismiss rate | < 20% (proxy for detection quality) |
| Clips exported per session | ≥ 3 (proxy for editor engagement) |
| Quick search → Full analysis upgrade rate | tracked (proxy for mode adoption) |
| Cache hit rate on Full analysis jobs | target ≥ 30% at scale (cost efficiency) |
