const BASE = '/api'

async function request<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as any).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface Project {
  id: string
  name: string
  analysis_mode: 'full' | 'quick'
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  created_at: string
  updated_at: string
}

export interface CreateProjectPayload {
  name: string
  analysisMode: 'full' | 'quick'
  quickSearchParams?: { players: string[]; scenes: string[] }
}

export const api = {
  createProject: (payload: CreateProjectPayload, token: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(payload) }, token),

  listProjects: (token: string) => request<Project[]>('/projects', {}, token),

  getProject: (id: string, token: string) => request<Project>(`/projects/${id}`, {}, token),
}
