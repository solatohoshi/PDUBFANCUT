const BASE = '/api'

let _authToken: string | null = null
export function setAuthToken(token: string | null) { _authToken = token }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`
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

export interface ProjectDetail extends Project {
  quick_search_params: { players: string[]; scenes: string[] } | null
  source_files: Array<{
    id: string
    original_name: string
    duration_secs: number | null
    status: string
  }> | null
  jobs: Array<{
    id: string
    type: string
    status: string
    error: string | null
  }> | null
}

export interface CreateProjectPayload {
  name: string
  analysisMode: 'full' | 'quick'
  quickSearchParams?: { players: string[]; scenes: string[] }
}

export interface SceneTag {
  tag: string
  confidence: number
}

export interface PlayerTag {
  jersey: string
  name: string
  team: string
}

export interface Clip {
  id: string
  project_id: string
  source_file_id: string
  timecode_in: string   // numeric string from postgres
  timecode_out: string
  scene_tags: SceneTag[]
  players: PlayerTag[]
  confidence: string    // numeric string from postgres
  thumb_key: string | null
  review_status: 'auto' | 'confirmed' | 'dismissed'
  created_at: string
}

export interface VideoExport {
  id: string
  project_id: string
  preset: 'tiktok' | 'twitter' | 'instagram' | 'fullres'
  status: 'rendering' | 'done' | 'failed'
  output_key: string | null
  duration_secs: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export const api = {
  createProject: (payload: CreateProjectPayload) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(payload) }),

  listProjects: () => request<Project[]>('/projects'),

  getProject: (id: string) => request<ProjectDetail>(`/projects/${id}`),

  getProjectClips: (projectId: string) =>
    request<Clip[]>(`/projects/${projectId}/clips`),

  createExport: (projectId: string, payload: { preset: string; timeline: object[]; captions?: object[] }) =>
    request<VideoExport>(`/projects/${projectId}/exports`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getExport: (exportId: string) =>
    request<VideoExport>(`/exports/${exportId}`),

  listExports: (projectId: string) =>
    request<VideoExport[]>(`/projects/${projectId}/exports`),

  updateClipStatus: (clipId: string, review_status: 'confirmed' | 'dismissed' | 'auto') =>
    request<Clip>(`/clips/${clipId}`, {
      method: 'PATCH',
      body: JSON.stringify({ review_status }),
    }),

  deleteProject: (projectId: string) =>
    request<void>(`/projects/${projectId}`, { method: 'DELETE' }),

  upgradeToFullAnalysis: (projectId: string) =>
    request<{ message: string }>(`/projects/${projectId}/full-analysis`, {
      method: 'POST', body: '{}',
    }),

  addSearch: (projectId: string, params: { players?: string[]; scenes?: string[] }) =>
    request<{ message: string; params: { players: string[]; scenes: string[] } }>(
      `/projects/${projectId}/searches`,
      { method: 'POST', body: JSON.stringify(params) },
    ),

  rethumb: (projectId: string) =>
    request<{ message: string }>(`/projects/${projectId}/rethumb`, { method: 'POST', body: '{}' }),

  reanalyze: (projectId: string) =>
    request<{ message: string }>(`/projects/${projectId}/reanalyze`, { method: 'POST', body: '{}' }),
}
