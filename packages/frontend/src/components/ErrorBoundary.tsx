import { Component, type ReactNode } from 'react'

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div style={styles.wrap}>
          <div style={styles.box}>
            <span style={styles.icon}>⚠</span>
            <h2 style={styles.title}>Something went wrong</h2>
            <pre style={styles.msg}>{error.message}</pre>
            <button
              style={styles.btn}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '60vh', padding: 32,
  },
  box: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 16, maxWidth: 480, textAlign: 'center',
  },
  icon: { fontSize: 40, color: '#f05060' },
  title: { fontSize: 18, fontWeight: 700, color: '#d0d0f0', margin: 0 },
  msg: {
    fontSize: 12, color: '#808090', fontFamily: 'monospace',
    background: '#0d0d1a', padding: '12px 16px', borderRadius: 6,
    border: '1px solid #1e1e30', whiteSpace: 'pre-wrap',
    textAlign: 'left', width: '100%',
  },
  btn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 13, fontWeight: 700, padding: '8px 20px',
    borderRadius: 6, cursor: 'pointer',
  },
}
