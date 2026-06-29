import { useRef, useState, useCallback } from 'react'

const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/mxf', '']
const MAX_BYTES = 20 * 1024 * 1024 * 1024 // 20 GB

interface Props {
  onFile: (file: File) => void
  disabled?: boolean
}

export function UploadZone({ onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validate = useCallback((file: File) => {
    if (file.size > MAX_BYTES) {
      setError('File exceeds the 20 GB limit.')
      return false
    }
    return true
  }, [])

  const handleFile = useCallback(
    (file: File) => {
      setError(null)
      if (validate(file)) onFile(file)
    },
    [onFile, validate]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  return (
    <div style={styles.wrapper}>
      <div
        style={{
          ...styles.zone,
          ...(dragOver ? styles.zoneActive : {}),
          ...(disabled ? styles.zoneDisabled : {}),
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/x-msvideo,.mxf,.avi"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
        <span style={styles.icon}>🎥</span>
        <p style={styles.primary}>Drop your video here or click to browse</p>
        <p style={styles.secondary}>MP4 · MOV · MXF · AVI &nbsp;·&nbsp; up to 20 GB</p>
      </div>
      {error && <p style={styles.error}>{error}</p>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { display: 'flex', flexDirection: 'column', gap: 8 },
  zone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 10, padding: '48px 32px', border: '2px dashed #2a2a3e', borderRadius: 14,
    cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s',
    background: '#111128',
  },
  zoneActive: { borderColor: '#6c63ff', background: '#1a1740' },
  zoneDisabled: { opacity: 0.5, pointerEvents: 'none' },
  icon: { fontSize: 40 },
  primary: { fontSize: 16, fontWeight: 600, color: '#d0d0e8' },
  secondary: { fontSize: 13, color: '#6060a0' },
  error: { fontSize: 13, color: '#f05060', padding: '6px 0' },
}
