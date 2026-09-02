import { useRef, useState, useEffect, forwardRef, useImperativeHandle, memo } from 'react'
import type { TimelineClip } from '../../hooks/useTimeline'
import type { TextSlot } from './CaptionTrack'
import { mediaUrl } from '../../lib/api'

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  const ms = Math.floor((secs % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${ms}`
}

interface Props {
  clip: TimelineClip | null
  /** Text overlays to composite on the preview. Each slot is positioned in
   * absolute timeline seconds (same domain as the shared multi-track
   * timeline in TimelineTrack.tsx) — shown here whenever the active clip's
   * absolute playhead position falls within [startSecs, startSecs+durationSecs),
   * matching what the export burns in via ffmpeg's `enable=between(...)`. */
  textSlots?: TextSlot[]
  /** The active clip's own start offset within the whole timeline (sum of
   * effectiveDuration for every preceding slot) — lets this single-clip
   * preview translate its local playhead into the same absolute domain
   * textSlots are positioned in. */
  clipAbsoluteStart?: number
  mediaToken?: string | null
}

// Memoized: re-renders when the active clip OR the text overlays change, but
// not on other unrelated editor state (library search keystrokes, etc.)
export interface PreviewPlayerHandle {
  togglePlay: () => void
  /** Absolute source-file time (seconds) the playhead is currently at. */
  getCurrentTime: () => number
}

const OVERLAY_STYLE_ORDER: TextSlot['style'][] = ['title', 'lower-third', 'caption']

// Positioning zone per overlay style — percentages of the video frame, so
// they hold up across every export preset's aspect ratio (portrait/square/landscape).
const OVERLAY_ZONE_STYLE: Record<TextSlot['style'], React.CSSProperties> = {
  title: {
    position: 'absolute', left: '8%', right: '8%', top: '10%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    pointerEvents: 'none', zIndex: 2,
  },
  'lower-third': {
    position: 'absolute', left: '6%', right: '6%', top: '76%',
    display: 'flex', flexDirection: 'column', gap: 4,
    pointerEvents: 'none', zIndex: 2,
  },
  caption: {
    position: 'absolute', left: '8%', right: '8%', top: '88%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    pointerEvents: 'none', zIndex: 2,
  },
}

const OVERLAY_LINE_STYLE: Record<TextSlot['style'], React.CSSProperties> = {
  title: {
    fontSize: '5.5cqw', fontWeight: 800, color: '#fff', textAlign: 'center',
    textShadow: '0 2px 8px rgba(0,0,0,0.85)', lineHeight: 1.2,
  },
  'lower-third': {
    fontSize: '3.2cqw', fontWeight: 700, color: '#fff', textAlign: 'left',
    background: 'rgba(0,0,0,0.55)', padding: '0.4em 0.7em', borderRadius: 4,
    alignSelf: 'flex-start', lineHeight: 1.3,
  },
  caption: {
    fontSize: '3cqw', fontWeight: 600, color: '#fff', textAlign: 'center',
    background: 'rgba(0,0,0,0.55)', padding: '0.3em 0.6em', borderRadius: 4,
    lineHeight: 1.3,
  },
}

export const PreviewPlayer = memo(forwardRef<PreviewPlayerHandle, Props>(function PreviewPlayer({ clip, textSlots = [], clipAbsoluteStart = 0, mediaToken }, ref) {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying]   = useState(false)
  const [current, setCurrent]   = useState(0)
  const [hasVideo, setHasVideo] = useState(false)
  const [loadError, setLoadError] = useState(false)

  // Keep latest clip values in refs so event-listener callbacks never go stale
  const clipRef      = useRef(clip)
  const clipStartRef = useRef(0)
  const clipEndRef   = useRef(0)
  clipRef.current      = clip
  clipStartRef.current = clip ? clip.tcIn  + clip.trimStart : 0
  clipEndRef.current   = clip ? clip.tcOut - clip.trimEnd   : 0

  const clipStart = clipStartRef.current
  const clipEnd   = clipEndRef.current
  const clipDur   = Math.max(0, clipEnd - clipStart) / (clip?.speed ?? 1)

  // Reset when the clip changes (new key on <video> handles the actual reload)
  useEffect(() => {
    setPlaying(false)
    setHasVideo(false)
    setLoadError(false)
    setCurrent(0)
  }, [clip?.id])

  // Attach native media event listeners — more reliable than JSX onLoadedMetadata
  // for non-bubbling events, and avoids the React re-render timing race.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onCanPlay = () => {
      const c = clipRef.current
      if (!c) return
      setHasVideo(true)
      setLoadError(false)
      if (c.speed !== 1) video.playbackRate = c.speed
      // Only seek if the video is paused (don't interrupt an in-progress play)
      if (video.paused) {
        video.currentTime = clipStartRef.current
      }
    }

    const onTimeUpdate = () => {
      const c = clipRef.current
      if (!c || !videoRef.current) return
      const rel = video.currentTime - clipStartRef.current
      setCurrent(Math.max(0, rel))
      if (clipEndRef.current > clipStartRef.current && video.currentTime >= clipEndRef.current) {
        video.pause()
        video.currentTime = clipStartRef.current
        setPlaying(false)
        setCurrent(0)
      }
    }

    const onError = () => {
      setHasVideo(false)
      setLoadError(true)
    }

    const onEnded = () => {
      setPlaying(false)
      setCurrent(0)
    }

    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('error', onError)
    video.addEventListener('ended', onEnded)

    // Handle already-ready video (e.g. browser cache fires canplay before listener attached)
    if (video.readyState >= 3) onCanPlay()

    return () => {
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('error', onError)
      video.removeEventListener('ended', onEnded)
    }
  }, [clip?.id])

  function togglePlay() {
    const video = videoRef.current
    if (!video || !clip) return

    if (video.paused) {
      // Seek to clip start if out of range (only when video data is ready)
      if (hasVideo && (video.currentTime >= clipEnd || video.currentTime < clipStart)) {
        video.currentTime = clipStart
      }
      // Always attempt play — browser buffers as needed; promise handles not-ready
      video.play()
        .then(() => setPlaying(true))
        .catch((err: DOMException) => {
          // AbortError is common when src changes mid-request; ignore it.
          // NotAllowedError means the browser blocked autoplay (rare for user clicks).
          if (err.name !== 'AbortError') {
            console.warn('[PreviewPlayer] play() rejected:', err.name, err.message)
          }
          setPlaying(false)
        })
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  function handleRestart() {
    const video = videoRef.current
    if (!video || !clip) return
    video.pause()
    video.currentTime = clipStart
    setCurrent(0)
    setPlaying(false)
  }

  useImperativeHandle(ref, () => ({
    togglePlay,
    // Read the live <video> position rather than the debounced `current` state
    // so a split lands exactly where the user paused, not a stale render.
    getCurrentTime: () => videoRef.current?.currentTime ?? clipStartRef.current,
  }))

  const progress = clipDur > 0 ? Math.min(1, current / clipDur) : 0

  return (
    <div style={styles.container}>
      {clip ? (
        <>
          <div style={styles.videoWrap}>
            <video
              key={`${clip.sourceFileId}:${clip.id}`}
              ref={videoRef}
              src={mediaUrl(`/api/files/${clip.sourceFileId}/stream`, mediaToken)}
              style={styles.video}
              preload="metadata"
              playsInline
            />
            {/* Overlay shows thumbnail + play button while video isn't ready */}
            {!hasVideo && (
              <div style={styles.noVideo} onClick={togglePlay}>
                {loadError ? (
                  <>
                    <span style={styles.noVideoIcon}>⚠️</span>
                    <p style={styles.noVideoText}>Video could not be loaded</p>
                    <p style={styles.noVideoHint}>Check that the source file exists and the backend is running</p>
                  </>
                ) : clip.thumbKey ? (
                  <>
                    <img
                      src={mediaUrl(`/api/files/${clip.thumbKey}`, mediaToken)}
                      style={styles.thumbImg}
                      alt=""
                      draggable={false}
                    />
                    <div style={styles.playOverlay}>
                      <div style={styles.playOverlayBtn}>▶</div>
                    </div>
                  </>
                ) : (
                  <>
                    <span style={styles.noVideoIcon}>🎬</span>
                    <p style={styles.noVideoText}>Loading video…</p>
                  </>
                )}
              </div>
            )}

            {/* Text overlays — grouped by style; multiple slots of the same
                style stack as separate lines within that style's zone.
                `current` is source-domain elapsed time within the clip (not
                speed-adjusted — currentTime advances at the source's own
                rate regardless of playbackRate), so divide by speed to land
                in the same absolute output-timeline domain textSlots use. */}
            {(() => {
              const absoluteCurrent = clipAbsoluteStart + current / (clip.speed || 1)
              return OVERLAY_STYLE_ORDER.map((style) => {
                const texts = textSlots.filter((s) =>
                  s.style === style && s.text.trim() !== ''
                  && absoluteCurrent >= s.startSecs && absoluteCurrent < s.startSecs + s.durationSecs,
                )
                if (texts.length === 0) return null
                return (
                  <div key={style} style={OVERLAY_ZONE_STYLE[style]}>
                    {texts.map((s) => (
                      <div key={s.id} style={OVERLAY_LINE_STYLE[style]}>{s.text}</div>
                    ))}
                  </div>
                )
              })
            })()}
          </div>

          {/* Progress bar */}
          <div style={styles.progressBar} onClick={(e) => {
            const video = videoRef.current
            if (!video || !clip || clipDur === 0) return
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
            const ratio = (e.clientX - rect.left) / rect.width
            const newTime = clipStart + ratio * clipDur
            video.currentTime = Math.max(clipStart, Math.min(clipEnd, newTime))
            setCurrent(video.currentTime - clipStart)
          }}>
            <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
          </div>

          {/* Transport controls */}
          <div style={styles.controls}>
            <button style={styles.ctrlBtn} onClick={handleRestart} title="Restart">⏮</button>
            <button style={styles.playBtn} onClick={togglePlay}>
              {playing ? '⏸' : '▶'}
            </button>
            <span style={styles.timeDisplay}>
              {formatTime(current)} / {formatTime(clipDur)}
            </span>
            <span style={styles.clipLabel} title={clip.label}>
              <span style={{ ...styles.clipDot, background: clip.color }} />
              {clip.label}
            </span>
            <span style={styles.speedTag}>{clip.speed}×</span>
          </div>
        </>
      ) : (
        <div style={styles.placeholder}>
          <span style={styles.placeholderIcon}>🎬</span>
          <p style={styles.placeholderText}>Select a clip from the timeline to preview</p>
        </div>
      )}
    </div>
  )
}))

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', flexDirection: 'column',
    background: '#0d0d1a', borderRadius: 8,
    border: '1px solid #1e1e30', overflow: 'hidden',
    flex: 1,
  },
  videoWrap: {
    position: 'relative', background: '#000',
    aspectRatio: '16/9', overflow: 'hidden',
    // Lets the text-overlay font sizes below use `cqw` (container query width)
    // so they scale with the actual rendered player box, not the viewport —
    // this box is a flex child at an unpredictable width, so `vw` would be wrong.
    containerType: 'inline-size',
  },
  video: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  noVideo: {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 8,
    background: '#050510', cursor: 'pointer',
  },
  thumbImg: {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover',
  },
  playOverlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.25)',
  },
  playOverlayBtn: {
    width: 56, height: 56, borderRadius: '50%',
    background: 'rgba(108,99,255,0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 22, color: '#fff',
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
  },
  noVideoIcon: { fontSize: 32 },
  noVideoText: { fontSize: 14, color: '#5050a0', margin: 0 },
  noVideoHint: { fontSize: 11, color: '#303060', margin: 0, textAlign: 'center', padding: '0 16px' },
  progressBar: {
    height: 4, background: '#1a1a30', cursor: 'pointer', flexShrink: 0,
  },
  progressFill: { height: '100%', background: '#6c63ff', transition: 'width 0.1s linear' },
  controls: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px', flexShrink: 0,
  },
  ctrlBtn: {
    background: 'none', border: 'none', color: '#6060a0',
    fontSize: 16, cursor: 'pointer', padding: '2px 4px',
  },
  playBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    width: 32, height: 32, borderRadius: '50%',
    fontSize: 13, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  timeDisplay: {
    fontSize: 12, color: '#c0c0e0', fontFamily: 'monospace',
    background: '#0d0d1a', padding: '2px 6px', borderRadius: 3,
  },
  clipLabel: {
    marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 11, fontWeight: 700, color: '#8080a0', letterSpacing: '0.05em',
  },
  clipDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  speedTag: {
    fontSize: 11, color: '#6060a0', background: '#0d0d1a',
    padding: '1px 5px', borderRadius: 3, border: '1px solid #1e1e30',
  },
  placeholder: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10,
    padding: 32, aspectRatio: '16/9',
  },
  placeholderIcon: { fontSize: 36, opacity: 0.3 },
  placeholderText: { fontSize: 13, color: '#4040a0', textAlign: 'center', margin: 0 },
}
