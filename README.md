# PDUB FanCut

PDUB FanCut is an AI-Powered video editing tool for creating short highlight
reels from Professional Women's Hockey League footage. It combines automated
hockey-event detection with a review and timeline-editing experience, allowing
a creator to move from a full game video to a focused fan cut in one workflow.

## How the system works

PDUB FanCut separates interactive requests from longer-running media jobs. The
web application manages projects, uploads, clip review, and timeline editing.
Background workers sample video frames for analysis, generate thumbnails, and
render the final timeline with FFmpeg. PostgreSQL stores project and analysis
data, while Redis and BullMQ coordinate queued work.

The project also contains an evaluation workflow for comparing detected goals
and saves against manually labeled events. It reports event-level precision,
recall, F1 score, clip-boundary error, processing time, and estimated model cost.
