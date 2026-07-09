# AI Pipeline Implementation Plan

## Current state

The worker (`worker.ts`) has **all 7 pipeline steps as stubs** — it generates random fake clips. Meanwhile, `analyzeVideo.ts` has a fully working Claude Opus multimodal integration that's never been connected to the worker. The edit/export stack is complete and working.

The training phase means: **replace the stubs with real detection**, then build the feedback loop that turns user-confirmed clips into training data for custom models later.

---

## First decision you need to make manually

The original plan assumed custom ML models (YOLOv8, VideoMAE). There's a faster alternative now that `analyzeVideo.ts` already exists. Three paths:

| | Path A: Claude multimodal only | Path B: Custom ML models | Path C: Hybrid (recommended) |
|---|---|---|---|
| Time to first real clips | Days | 8–12 weeks | Days |
| Accuracy | Good immediately | Better ceiling, starts worse | Good now, improves over time |
| Cost at scale | ~$0.50–2.00/game file | Cheap after training | Decreasing as data grows |
| Training data needed | Zero | 500–1,000 clips/category | Grows from real usage |
| PWHL-specific tuning | Prompt only | Full fine-tune | Both |

**Recommendation:** Start with Path C — wire Claude in now to get real clips flowing, then graduate to custom models as the labeled dataset accumulates from the review queue. The infrastructure for both is the same.

---

## What AI (Claude Code) will implement

**1. Replace `stubFrameSample` → real ffprobe**
Replace the random duration generator in `worker.ts` with a call to `ffprobe()` from `ffmpeg.ts`. Get a presigned URL for the uploaded S3/R2 file, probe it, write real `duration_secs`, `codec`, `width`, `height` back to `source_files`.

**2. Video chunking pipeline**
A 3-hour game can't be sent to Claude in one call. Write a `chunkVideo()` function that uses ffmpeg to cut the source file into 60-second segments. Each chunk gets its own Claude call; results get merged with offset-corrected timecodes.

**3. Replace `stubDetect` → Claude scene classifier**
Wire `analyzeVideo.ts` into the worker per-chunk. The existing prompt already covers all 8 scene tags, player extraction, and confidence scoring. This replaces steps 2–5 of the stub pipeline with real detection.

**4. Real boundary detection (Step 6)**
Given event timestamps from the classifier, extract a ±5-second 30fps window via ffmpeg and run a focused second Claude call to find the precise in-point (wind-up, not contact) and out-point (celebration ends, not whistle).

**5. Thumbnail generation per clip (Step 7)**
`generateClipThumbnail()` already exists in `ffmpeg.ts`. Wire it in for each detected clip, upload the JPEG to R2, write the `thumb_key` to the clips row.

**6. Training data table + export**
Add a `training_examples` table to the schema. When a user confirms or dismisses a clip in the review queue, write the labeled example there. Add a `/api/training-data/export` endpoint that dumps the dataset as JSONL (compatible with fine-tuning pipelines).

**7. Eval harness**
A script that runs the pipeline against a fixed test set of hand-labeled clips and prints precision/recall/F1 per scene category. This is the main tool for measuring whether changes improve detection quality.

**8. Custom model API client (later)**
Once you have trained models deployed on Modal or RunPod, write the client that calls those endpoints instead of Claude. The worker's Step 3–5 slots are already structured for this replacement.

---

## What you must do manually

**1. Source PWHL game files** *(blocking)*
You need at least 5 full game files to start, 20 to hit the training data targets in the plan. The plan says fans get these from VODs they already own. You'll need to actually acquire these files before any real detection can be tested.

**2. GPU infrastructure setup** *(one-time)*
Create a [Modal](https://modal.com) or [RunPod](https://runpod.io) account, set up billing, create a workspace. Takes ~30 minutes, needed before any custom model training or deployment.

**3. Initial labeling session** *(ongoing, weeks 5–10)*
Once the review queue is showing real Claude-detected clips, you need to sit down and do confirm/dismiss on ~1,000 clips per category to build the training dataset. AI can surface the clips and build the UI, but the label decision on each clip is a human judgment call.

**4. PWHL roster data** *(manual, recurring)*
Build a JSON file mapping `team → jersey number → player name` for the current season. This powers the jersey number → player name lookup in the detection prompt. Needs manual updates when rosters change.

**5. Training run execution and evaluation**
Once the dataset hits ~500 labeled clips per category, I can write the training scripts (YOLOv8 fine-tune, VideoMAE transfer learning). But you need to actually run those scripts on the GPU instance, watch the loss curves, and decide when to stop.

**6. Model accuracy sign-off** *(before shipping)*
The plan sets ≥85% precision as the launch bar. Reviewing the eval harness output and deciding "this is good enough to show users" is a human decision.

---

## Recommended implementation order

```
Week 1 (now)
  ├─ Wire ffprobe into worker (Step 1)           ← AI does this
  ├─ Build video chunking utility                 ← AI does this
  └─ Connect analyzeVideo.ts to worker            ← AI does this

Week 2
  ├─ Real boundary detection (Step 6)            ← AI does this
  ├─ Thumbnail generation wiring (Step 7)        ← AI does this
  └─ Source first 5 PWHL game files              ← YOU do this

Week 3
  ├─ PWHL roster JSON file                       ← YOU do this
  ├─ Build eval harness                           ← AI does this
  └─ Run first real detection tests on game files ← joint

Week 4
  ├─ Training data table + export endpoint        ← AI does this
  ├─ Review queue wired to capture labels         ← AI does this
  └─ Start labeling session (review queue)        ← YOU do this (ongoing)

Weeks 5–10 (data accumulation, human-gated)
  ├─ Iterate on Claude prompts based on eval output  ← AI does this
  ├─ Build custom model training scripts             ← AI does this
  ├─ Label 500+ clips/category via review queue      ← YOU do this
  └─ Run training on Modal/RunPod                    ← YOU trigger, AI wrote the scripts

Week 10+ (custom model integration)
  └─ Replace Claude calls with custom model endpoints ← AI does this
```

---

## The most important practical constraint

The worker currently calls **zero real AI** — every clip it produces is fake. The single highest-leverage move right now is wiring `analyzeVideo.ts` into the worker with chunking. Once that's done, every upload produces real AI-detected clips and the review queue starts collecting real training labels.
