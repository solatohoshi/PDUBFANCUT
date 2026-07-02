import { useRef, useState, useEffect } from 'react'
import type { TimelineClip } from '../../hooks/useTimeline'

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  const ms = Math.floor((secs % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${ms}`
}

interface Props {
  clip: TimelineClip | null
}

export function PreviewPlayer({ clip }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying]   = useState(false)
  const [current, setCurrent]   = useState(0)
  const [hasVideo, setHasVideo] = useState(false)

  const clipStart = clip ? clip.tcIn + clip.trimStart : 0
  const clipEnd   = clip ? clip.tcOut - clip.trimEnd  : 0
  const clipDur   = Math.max(0, clipEnd - clipStart) / (clip?.speed ?? 1)

  // Seek to clip start whenever active clip changes
  useEffect(() => {
    const video = videoRef.current
    if (!video || !clip) return
    setPlaying(false)
    setHasVideo(false)
    setCurrent(0)
  }, [clip?.sourceFileId, clip?.id])

  function handleLoaded() {
    const video = videoRef.current
    if (!video || !clip) return
    setHasVideo(true)
    video.currentTime = clipStart
    if (clip.speed !== 1) video.playbackRate = clip.speed
  }

  function handleTimeUpdate() {
    const video = videoRef.current
    if (!video || !clip) return
    const rel = video.currentTime - clipStart
    setCurrent(Math.max(0, rel))
    if (video.currentTime >= clipEnd) {
      video.pause()
      video.currentTime = clipStart
      setPlaying(false)
      setCurrent(0)
    }
  }

  function togglePlay() {
    const video = videoRef.current
    if (!video || !clip) return
    if (video.paused) {
      if (video.currentTime >= clipEnd || video.currentTime < clipStart) {
        video.currentTime = clipStart
      }
      video.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
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

  const progress = clipDur > 0 ? Math.min(1, current / clipDur) : 0

  return (
    <div style={styles.container}>
      {clip ? (
        <>
          <div style={styles.videoWrap}>
            <video
              key={`${clip.sourceFileId}:${clip.id}`}
              ref={videoRef}
              src={`/api/files/${clip.sourceFileId}/stream`}
              style={styles.video}
              preload="metadata"
              onLoadedMetadata={handleLoaded}
              onTimeUpdate={handleTimeUpdate}
              onError={() => setHasVideo(false)}
            />
            {!hasVideo && (
              <div style={styles.noVideo}>
                <span style={styles.noVideoIcon}>🎬</span>
                <p style={styles.noVideoText}>
                  Video preview unavailable
                </p>
                <p style={styles.noVideoHint}>File streams from R2 when a real upload is processed</p>
              </div>
            )}
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
}

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
  },
  video: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  noVideo: {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 8,
    background: '#050510',
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
