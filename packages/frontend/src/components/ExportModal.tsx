import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { TimelineClip } from '../hooks/useTimeline'
import type { TextSlot } from './timeline/CaptionTrack'

const PRESETS = [
  {
    id: 'tiktok' as const,
    label: 'TikTok / Reels',
    icon: '📱',
    ratio: '9:16',
    res: '1080×1920',
    maxSecs: 60,
    accent: '#ee1d52',
  },
  {
    id: 'twitter' as const,
    label: 'X / Twitter',
    icon: '🐦',
    ratio: '16:9',
    res: '1920×1080',
    maxSecs: 140,
    accent: '#1da1f2',
  },
  {
    id: 'instagram' as const,
    label: 'Instagram',
    icon: '📷',
    ratio: '1:1',
    res: '1080×1080',
    maxSecs: 60,
    accent: '#e1306c',
  },
  {
    id: 'fullres' as const,
    label: 'Full resolution',
    icon: '💾',
    ratio: 'Original',
    res: 'Up to 4K',
    maxSecs: null,
    accent: '#6c63ff',
  },
]

function formatDur(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const TEAM_HASHTAG: Record<string, string> = {
  BOS: '#PWHLBoston', MIN: '#PWHLMinnesota', MTL: '#PWHLMTL',
  NY:  '#PWHLNewYork', OTT: '#PWHLOttawa', TOR: '#PWHLToronto',
}

function buildCaption(timeline: TimelineClip[]): string {
  const scenes   = [...new Set(timeline.map((s) => s.label))]
  const sceneStr = scenes.slice(0, 3).join(' · ')
  return `${sceneStr ? sceneStr + ' 🏒\n' : '🏒 PWHL highlights\n'}#PWHL #WomensHockey #WatchPWHL`
}

interface Props {
  projectId: string
  timeline: TimelineClip[]
  captions: TextSlot[]
  musicVolume?: number
  totalDuration: number
  onClose: () => void
}

export function ExportModal({ projectId, timeline, captions, musicVolume, totalDuration, onClose }: Props) {
  const [step, setStep]           = useState<'preset' | 'rendering' | 'done' | 'share' | 'error'>('preset')
  const [preset, setPreset]       = useState<string | null>(null)
  const [exportId, setExportId]   = useState<string | null>(null)
  const [errorMsg, setErrorMsg]   = useState<string | null>(null)
  const [fakeProgress, setFakeProgress] = useState(0)
  const [caption, setCaption]     = useState('')
  const [captionCopied, setCaptionCopied] = useState(false)

  // Animate the progress bar while rendering
  useEffect(() => {
    if (step !== 'rendering') return
    setFakeProgress(0)
    const tick = setInterval(() => {
      setFakeProgress((p) => Math.min(95, p + (95 - p) * 0.08))
    }, 200)
    return () => clearInterval(tick)
  }, [step])

  // Poll for completion
  useEffect(() => {
    if (step !== 'rendering' || !exportId) return
    const timer = setInterval(async () => {
      try {
        const result = await api.getExport(exportId)
        if (result.status === 'done') {
          setFakeProgress(100)
          setCaption(buildCaption(timeline))
          setTimeout(() => setStep('done'), 300)
          clearInterval(timer)
        } else if (result.status === 'failed') {
          setErrorMsg(result.error ?? 'Export failed')
          setStep('error')
          clearInterval(timer)
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [step, exportId])

  async function startExport() {
    if (!preset) return
    try {
      const result = await api.createExport(projectId, {
        preset,
        timeline: timeline as object[],
        captions: captions as object[],
        musicVolume,
      })
      setExportId(result.id)
      setStep('rendering')
    } catch (e: any) {
      setErrorMsg(e.message)
      setStep('error')
    }
  }

  function copyLink() {
    if (!exportId) return
    const url = `${window.location.origin}/api/exports/${exportId}/download`
    navigator.clipboard.writeText(url).catch(() => {})
  }

  const selectedPreset = PRESETS.find((p) => p.id === preset)
  const exceedsLimit = selectedPreset?.maxSecs != null && totalDuration > selectedPreset.maxSecs

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>
            {step === 'preset'    && 'Export'}
            {step === 'rendering' && 'Rendering…'}
            {step === 'done'      && 'Export ready'}
            {step === 'share'     && 'Share'}
            {step === 'error'     && 'Export failed'}
          </span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* ── Step 1: Preset selection ────────────────────────────────── */}
        {step === 'preset' && (
          <>
            <div style={styles.statRow}>
              <span style={styles.stat}>
                <span style={styles.statNum}>{timeline.length}</span> clip{timeline.length !== 1 ? 's' : ''}
              </span>
              <span style={styles.statDot}>·</span>
              <span style={styles.stat}>
                <span style={styles.statNum}>{formatDur(totalDuration)}</span> total
              </span>
            </div>

            <div style={styles.presetGrid}>
              {PRESETS.map((p) => (
                <div
                  key={p.id}
                  style={{
                    ...styles.presetCard,
                    borderColor: preset === p.id ? p.accent : '#1e1e30',
                    background:  preset === p.id ? '#12102a' : '#111128',
                  }}
                  onClick={() => setPreset(p.id)}
                >
                  <span style={styles.presetIcon}>{p.icon}</span>
                  <span style={styles.presetLabel}>{p.label}</span>
                  <span style={{ ...styles.presetRatio, color: p.accent }}>{p.ratio}</span>
                  <span style={styles.presetRes}>{p.res}</span>
                  <span style={styles.presetMax}>
                    {p.maxSecs != null ? `Max ${p.maxSecs}s` : 'No limit'}
                  </span>
                  {preset === p.id && <span style={{ ...styles.checkMark, color: p.accent }}>✓</span>}
                </div>
              ))}
            </div>

            {exceedsLimit && selectedPreset && (
              <div style={styles.warning}>
                ⚠ Timeline is {formatDur(totalDuration)} — exceeds the {selectedPreset.maxSecs}s limit for {selectedPreset.label}.
                The rendered file will be truncated.
              </div>
            )}

            <div style={styles.modalFooter}>
              <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
              <button
                style={{ ...styles.exportStartBtn, opacity: preset ? 1 : 0.4 }}
                disabled={!preset}
                onClick={startExport}
              >
                Start export
              </button>
            </div>
          </>
        )}

        {/* ── Step 2: Rendering ───────────────────────────────────────── */}
        {step === 'rendering' && (
          <div style={styles.renderingBody}>
            <div style={styles.renderIconWrap}>
              <span style={styles.renderIcon}>🎬</span>
            </div>
            <p style={styles.renderLabel}>
              Rendering {selectedPreset?.label ?? preset} export…
            </p>
            <p style={styles.renderHint}>
              In stub mode this completes in ~3–5 seconds. With real FFmpeg, this takes 1–3 minutes.
            </p>
            <div style={styles.progressBar}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${fakeProgress}%`,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <span style={styles.progressPct}>{Math.round(fakeProgress)}%</span>
          </div>
        )}

        {/* ── Step 3: Done ────────────────────────────────────────────── */}
        {step === 'done' && (
          <div style={styles.doneBody}>
            <span style={styles.doneIcon}>✅</span>
            <p style={styles.doneTitle}>Export complete</p>
            <p style={styles.doneHint}>
              Stub mode: the file record is created but no actual MP4 was rendered.
              Wire up a cloud FFmpeg worker (Modal / RunPod) to enable real downloads.
            </p>
            <div style={styles.doneActions}>
              <a
                href={`/api/exports/${exportId}/download`}
                download
                style={styles.downloadBtn}
              >
                ↓ Download
              </a>
              <button style={styles.copyBtn} onClick={copyLink}>
                Copy link
              </button>
              <button style={styles.shareBtn} onClick={() => setStep('share')}>
                Share caption →
              </button>
            </div>
            <button
              style={styles.anotherBtn}
              onClick={() => { setStep('preset'); setPreset(null); setExportId(null) }}
            >
              Export another format
            </button>
          </div>
        )}

        {/* ── Step 4: Share caption ───────────────────────────────────── */}
        {step === 'share' && (
          <div style={styles.shareBody}>
            <p style={styles.shareHint}>
              Copy this caption to post alongside your clip. Edit it before sharing.
            </p>
            <textarea
              style={styles.captionArea}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={5}
            />
            <div style={styles.teamHashtags}>
              <span style={styles.teamLabel}>Add team tag:</span>
              {Object.entries(TEAM_HASHTAG).map(([, tag]) => (
                <button
                  key={tag}
                  style={styles.tagChip}
                  onClick={() => setCaption((c) => c.includes(tag) ? c : `${c} ${tag}`)}
                >
                  {tag}
                </button>
              ))}
            </div>
            <div style={styles.shareActions}>
              <button style={styles.cancelBtn} onClick={() => setStep('done')}>← Back</button>
              <button
                style={{ ...styles.exportStartBtn, ...(captionCopied ? { background: '#40d080' } : {}) }}
                onClick={() => {
                  navigator.clipboard.writeText(caption).catch(() => {})
                  setCaptionCopied(true)
                  setTimeout(() => setCaptionCopied(false), 2000)
                }}
              >
                {captionCopied ? '✓ Copied!' : 'Copy caption'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Error ───────────────────────────────────────────── */}
        {step === 'error' && (
          <div style={styles.errorBody}>
            <span style={styles.errorIcon}>⚠</span>
            <p style={styles.errorMsg}>{errorMsg}</p>
            <button
              style={styles.retryBtn}
              onClick={() => { setStep('preset'); setErrorMsg(null) }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 200,
  },
  modal: {
    background: '#0d0d1a', border: '1px solid #1e1e30',
    borderRadius: 12, width: '100%', maxWidth: 560,
    maxHeight: '90vh', overflow: 'auto',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  },
  modalHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid #1a1a2e', flexShrink: 0,
  },
  modalTitle: { fontSize: 16, fontWeight: 700, color: '#e0e0f0' },
  closeBtn: {
    background: 'none', border: 'none', color: '#6060a0',
    fontSize: 18, cursor: 'pointer', padding: '0 4px',
  },

  statRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 20px 4px', flexShrink: 0,
  },
  stat: { fontSize: 13, color: '#6060a0' },
  statNum: { color: '#c0c0e0', fontWeight: 700 },
  statDot: { color: '#303060' },

  presetGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: 10, padding: '12px 20px',
  },
  presetCard: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '14px 16px', border: '1px solid',
    borderRadius: 8, cursor: 'pointer',
    position: 'relative', transition: 'border-color 0.15s',
  },
  presetIcon: { fontSize: 22, marginBottom: 2 },
  presetLabel: { fontSize: 13, fontWeight: 700, color: '#d0d0f0' },
  presetRatio: { fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em' },
  presetRes: { fontSize: 11, color: '#505080' },
  presetMax: { fontSize: 11, color: '#404060' },
  checkMark: {
    position: 'absolute', top: 10, right: 12,
    fontSize: 16, fontWeight: 800,
  },

  warning: {
    margin: '0 20px 12px',
    background: '#1a1200', border: '1px solid #604010',
    borderRadius: 6, padding: '8px 12px',
    fontSize: 12, color: '#c09040',
    flexShrink: 0,
  },

  modalFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '12px 20px', borderTop: '1px solid #1a1a2e', flexShrink: 0,
  },
  cancelBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#6060a0',
    fontSize: 13, padding: '7px 16px', borderRadius: 6, cursor: 'pointer',
  },
  exportStartBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 13, fontWeight: 700, padding: '7px 20px',
    borderRadius: 6, cursor: 'pointer',
  },

  renderingBody: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '32px 24px', gap: 12,
  },
  renderIconWrap: {
    width: 64, height: 64, borderRadius: '50%',
    background: '#12102a', border: '1px solid #2a2a4a',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  renderIcon: { fontSize: 28 },
  renderLabel: { fontSize: 15, fontWeight: 600, color: '#d0d0f0', margin: 0 },
  renderHint: { fontSize: 12, color: '#505080', textAlign: 'center', margin: 0, maxWidth: 380 },
  progressBar: {
    width: '100%', height: 6, background: '#1a1a30',
    borderRadius: 3, overflow: 'hidden', marginTop: 8,
  },
  progressFill: { height: '100%', background: '#6c63ff', borderRadius: 3 },
  progressPct: { fontSize: 12, color: '#6060a0' },

  doneBody: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '32px 24px', gap: 12,
  },
  doneIcon: { fontSize: 40 },
  doneTitle: { fontSize: 18, fontWeight: 700, color: '#e0e0f0', margin: 0 },
  doneHint: {
    fontSize: 12, color: '#505080', textAlign: 'center',
    maxWidth: 380, lineHeight: 1.6, margin: 0,
  },
  doneActions: { display: 'flex', gap: 10, marginTop: 4 },
  downloadBtn: {
    background: '#6c63ff', color: '#fff',
    fontSize: 13, fontWeight: 700, padding: '8px 20px',
    borderRadius: 6, textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center',
  },
  copyBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#a0a0c0',
    fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
  },
  anotherBtn: {
    background: 'none', border: 'none', color: '#6060a0',
    fontSize: 12, cursor: 'pointer', padding: '4px',
    textDecoration: 'underline',
  },

  shareBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#a0a0c0',
    fontSize: 13, padding: '8px 14px', borderRadius: 6, cursor: 'pointer',
  },
  shareBody: {
    display: 'flex', flexDirection: 'column', gap: 14,
    padding: '20px 24px',
  },
  shareHint: { fontSize: 12, color: '#505080', margin: 0 },
  captionArea: {
    background: '#111128', border: '1px solid #1e1e30',
    color: '#e0e0f0', fontSize: 13, lineHeight: 1.6,
    padding: '10px 12px', borderRadius: 6, resize: 'vertical',
    fontFamily: 'inherit', outline: 'none',
  },
  teamHashtags: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  teamLabel: { fontSize: 11, color: '#505080' },
  tagChip: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080c0',
    fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
  },
  shareActions: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    paddingTop: 4,
  },
  errorBody: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '32px 24px', gap: 12,
  },
  errorIcon: { fontSize: 36 },
  errorMsg: { fontSize: 13, color: '#f05060', textAlign: 'center', margin: 0, maxWidth: 380 },
  retryBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 13, fontWeight: 700, padding: '8px 20px',
    borderRadius: 6, cursor: 'pointer',
  },
}
