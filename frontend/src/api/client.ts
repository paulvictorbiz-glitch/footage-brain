/**
 * Typed API client for Footage Brain backend.
 * All calls go through /api prefix.
 */
import axios, { AxiosInstance } from 'axios'

const BASE = '/api'

export const http: AxiosInstance = axios.create({
  baseURL: BASE,
  timeout: 30000,
})

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScanRoot {
  id: string
  path: string
  label?: string
  enabled: boolean
  recursive: boolean
  created_at: string
  last_scanned_at?: string
  file_count?: number
  /** True when the directory exists on the current machine right now. */
  is_online: boolean
}

export interface RelinkResult {
  old_path: string
  new_path: string
  remapped: number
  unmatched: number
  dry_run: boolean
}

export interface VideoFile {
  id: string
  abs_path: string
  filename: string
  extension: string
  file_size: number
  created_time?: string
  modified_time?: string
  sha256?: string
  duration_seconds?: number
  fps?: number
  width?: number
  height?: number
  video_codec?: string
  audio_codec?: string
  has_audio: boolean
  bit_rate?: number
  aspect_ratio?: string
  is_vertical: boolean
  project_tag?: string
  thumbnail_path?: string
  metadata_extracted: boolean
  hashed: boolean
  transcribed: boolean
  embedded: boolean
  clip_embedded?: boolean
  scan_root_id?: string
  duplicate_group_id?: string
  is_canonical: boolean
  archive_status: string
  created_at: string
}

export interface TranscriptChunk {
  id: string
  chunk_index: number
  start_time: number
  end_time: number
  text: string
  language?: string
}

export interface IngestJob {
  id: string
  video_file_id: string
  stage: string
  status: string
  attempts: number
  error_message?: string
  created_at: string
  started_at?: string
  finished_at?: string
}

export interface ChunkMatch {
  chunk_id: string
  start_time: number
  end_time: number
  text: string
  score: number
}

export interface FrameMatch {
  frame_id: string
  timestamp: number
  score: number
}

export interface SearchResult {
  video_file_id: string
  filename: string
  abs_path: string
  extension: string
  duration_seconds?: number
  thumbnail_path?: string
  width?: number
  height?: number
  is_vertical: boolean
  project_tag?: string
  scan_root_id?: string
  has_audio: boolean
  sha256?: string
  duplicate_group_id?: string
  is_canonical: boolean
  best_score: number
  matched_chunks: ChunkMatch[]
  frame_matches?: FrameMatch[]
}

export interface SearchResponse {
  query: string
  mode: string
  total: number
  results: SearchResult[]
}

export interface SearchRequest {
  query?: string
  mode?: import('@/lib/search-modes').SearchMode
  n_results?: number
  offset?: number
  project_tag?: string
  source_root_id?: string
  min_duration?: number
  max_duration?: number
  aspect_ratio?: string
  is_vertical?: boolean
  has_duplicates_only?: boolean
  unique_only?: boolean
  extension?: string
  date_from?: string
  date_to?: string
}

export interface DuplicateGroup {
  id: string
  sha256: string
  canonical_file_id?: string
  file_count: number
  files: VideoFile[]
}

export interface DashboardStats {
  total_files: number
  total_indexed: number
  total_transcribed: number
  total_embedded: number
  total_duration_hours: number
  total_size_bytes: number
  duplicate_groups: number
  duplicate_files: number
  storage_by_root: Array<{
    root_id: string
    label: string
    path: string
    file_count: number
    total_bytes: number
  }>
  job_stats: Record<string, number>
  recent_files: VideoFile[]
}

export interface JobQueueData {
  queue_stats: Record<string, number>
  processing: IngestJob[]
  failed: IngestJob[]
}

export interface ThermalConfig {
  selected_limit: number
  auto_mode: boolean
  poll_interval_ms: number
  rolling_avg_window_min: number
  cooldown_threshold_c: number
  resume_threshold_c: number
  throttle_backoff_step: number
  recovery_step: number
  min_time_between_adjustments_sec: number
  default_batch_size: number
  monitor_only: boolean
}

export interface ThermalStatus {
  state: string
  current_temp: number | null
  rolling_avg: number | null
  session_avg: number | null
  peak_temp: number | null
  cpu_load: number | null
  effective_clock_mhz: number | null
  is_throttling: boolean | null
  throttle_source: string
  provider: string
  sensor_name: string
  time_throttling_sec: number
  current_delay_sec: number
  auto_limit_effective: number
  status_message: string
  last_update: string
  is_stale: boolean
  config: ThermalConfig
}

export interface ThermalEvent {
  timestamp: string
  event_type: string
  message: string
  temp: number | null
}

export interface TimelineClip {
  id: string
  timeline_id: string
  track: number
  position: number
  in_point?: number
  out_point?: number
  timeline_start?: number
  label?: string
  notes?: string
  created_at: string
  video_file: VideoFile
}

export interface Timeline {
  id: string
  name: string
  description?: string
  created_at: string
  updated_at: string
  clips: TimelineClip[]
}

export interface TimelineListItem {
  id: string
  name: string
  description?: string
  created_at: string
  updated_at: string
  clip_count: number
}

// ─── API methods ─────────────────────────────────────────────────────────────

// Sources
export const api = {
  // Dashboard
  async getDashboardStats(): Promise<DashboardStats> {
    const { data } = await http.get('/dashboard/stats')
    return data
  },
  async getJobQueue(): Promise<JobQueueData> {
    const { data } = await http.get('/dashboard/jobs')
    return data
  },
  async startWorker() {
    const { data } = await http.post('/dashboard/start-worker')
    return data
  },
  async getSettings() {
    const { data } = await http.get('/dashboard/settings')
    return data
  },

  // Sources
  async getSources(): Promise<ScanRoot[]> {
    const { data } = await http.get('/sources')
    return data
  },
  async addSource(path: string, label?: string, recursive?: boolean): Promise<ScanRoot> {
    const { data } = await http.post('/sources', { path, label, recursive: recursive ?? true })
    return data
  },
  async updateSource(id: string, updates: { label?: string; enabled?: boolean; recursive?: boolean }): Promise<ScanRoot> {
    const { data } = await http.patch(`/sources/${id}`, updates)
    return data
  },
  async deleteSource(id: string): Promise<void> {
    await http.delete(`/sources/${id}`)
  },
  async getSource(id: string): Promise<ScanRoot> {
    const { data } = await http.get(`/sources/${id}`)
    return data
  },
  async scanSource(id: string) {
    const { data } = await http.post(`/sources/${id}/scan`)
    return data
  },
  async scanAll() {
    const { data } = await http.post('/sources/scan-all')
    return data
  },
  async relinkSource(id: string, newPath: string, dryRun = false): Promise<RelinkResult> {
    const { data } = await http.post(`/sources/${id}/relink`, {
      new_path: newPath,
      dry_run: dryRun,
    })
    return data
  },

  async getFolderStructure(): Promise<any> {
    const { data } = await http.get('/dashboard/folders')
    return data
  },

  // Files
  async getFiles(params?: { limit?: number; offset?: number; scan_root_id?: string; abs_folder?: string; sort_by?: string }): Promise<VideoFile[]> {
    const { data } = await http.get('/files', { params })
    return data
  },
  async getFile(id: string): Promise<VideoFile> {
    const { data } = await http.get(`/files/${id}`)
    return data
  },
  async updateFile(id: string, updates: { project_tag?: string; is_canonical?: boolean; archive_status?: string }): Promise<VideoFile> {
    const { data } = await http.patch(`/files/${id}`, updates)
    return data
  },
  async getTranscript(id: string): Promise<TranscriptChunk[]> {
    const { data } = await http.get(`/files/${id}/transcript`)
    return data
  },
  async getFileJobs(id: string): Promise<IngestJob[]> {
    const { data } = await http.get(`/files/${id}/jobs`)
    return data
  },
  async reprocessFile(id: string, stages?: string[]) {
    const { data } = await http.post(`/files/${id}/reprocess`, null, {
      params: stages ? { stages } : undefined,
    })
    return data
  },

  // Search
  async getSearchModes(): Promise<{ modes: string[] }> {
    const { data } = await http.get('/search/modes')
    return data
  },

  async searchDiagnose(q: string, n: number = 3): Promise<{
    query: string
    n: number
    results: Record<string, Array<{
      video_file_id: string
      filename: string
      thumbnail_path: string | null
      duration_seconds: number | null
      best_score: number
      snippet: string | null
      frame_timestamp: number | null
      _error?: string
    }>>
  }> {
    const { data } = await http.get('/tools/search-diagnose', { params: { q, n } })
    return data
  },

  async search(req: SearchRequest): Promise<SearchResponse> {
    const { data } = await http.post('/search', req)
    return data
  },

  // Duplicates
  async getDuplicateGroups(params?: { limit?: number; offset?: number }): Promise<DuplicateGroup[]> {
    const { data } = await http.get('/duplicates', { params })
    return data
  },
  async getDuplicateGroup(id: string): Promise<DuplicateGroup> {
    const { data } = await http.get(`/duplicates/${id}`)
    return data
  },
  async setCanonical(groupId: string, fileId: string): Promise<DuplicateGroup> {
    const { data } = await http.post(`/duplicates/${groupId}/set-canonical`, { file_id: fileId })
    return data
  },
  async getDuplicatesSummary() {
    const { data } = await http.get('/duplicates/stats/summary')
    return data
  },

  async pauseJobs() {
    const { data } = await http.post('/dashboard/jobs/pause')
    return data
  },
  async resumeJobs() {
    const { data } = await http.post('/dashboard/jobs/resume')
    return data
  },
  async reconcileStreams(): Promise<{ requeued: Record<string, number> }> {
    const { data } = await http.post('/dashboard/streams/reconcile')
    return data
  },
  async rebuildStreams(streams?: string[]): Promise<{ requeued: Record<string, number> }> {
    const { data } = await http.post('/dashboard/streams/rebuild', { streams })
    return data
  },

  async skipStage(stage: string) {
    const { data } = await http.post('/dashboard/jobs/skip-stage', null, { params: { stage } })
    return data
  },
  async restoreStage(stage: string) {
    const { data } = await http.post('/dashboard/jobs/restore-stage', null, { params: { stage } })
    return data
  },
  async getStageStatus() {
    const { data } = await http.get('/dashboard/jobs/stage-status')
    return data
  },

  // Tools - Storage
  async getStorageStats() {
    const { data } = await http.get('/tools/storage')
    return data
  },

  // Tools - Batch tagging
  async batchTag(fileIds: string[], projectTag: string) {
    const { data } = await http.post('/tools/batch-tag', fileIds, { params: { project_tag: projectTag } })
    return data
  },
  async getProjectTags(): Promise<{ tags: string[] }> {
    const { data } = await http.get('/tools/project-tags')
    return data
  },

  // Tools - CSV Export
  async exportSearchCsv(fileIds: string[]): Promise<void> {
    const response = await http.post('/tools/export/search-csv', fileIds, { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([response.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `footage_export_${Date.now()}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  },
  async exportDuplicatesCsv(): Promise<void> {
    const response = await http.get('/tools/export/duplicates-csv', { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([response.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `duplicates_${Date.now()}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  },

  // Tools - Search history
  async addSearchHistory(query: string, mode: string, resultCount: number) {
    const { data } = await http.post('/tools/search-history', null, {
      params: { query, mode, result_count: resultCount }
    })
    return data
  },
  async getSearchHistory(): Promise<{ history: Array<{ id: string; query: string; mode: string; result_count: number; created_at: string }> }> {
    const { data } = await http.get('/tools/search-history')
    return data
  },
  async clearSearchHistory() {
    await http.delete('/tools/search-history')
  },

  // Tools - Project stats
  async getProjectStats() {
    const { data } = await http.get('/tools/project-stats')
    return data
  },

  // Tools - Indexing speed
  async getIndexingSpeed() {
    const { data } = await http.get('/tools/indexing-speed')
    return data
  },

  // Timelines
  async listTimelines(): Promise<TimelineListItem[]> {
    const { data } = await http.get('/timelines')
    return data
  },
  async createTimeline(name: string, description?: string): Promise<Timeline> {
    const { data } = await http.post('/timelines', { name, description })
    return data
  },
  async getTimeline(id: string): Promise<Timeline> {
    const { data } = await http.get(`/timelines/${id}`)
    return data
  },
  async updateTimeline(id: string, updates: { name?: string; description?: string }): Promise<Timeline> {
    const { data } = await http.patch(`/timelines/${id}`, updates)
    return data
  },
  async deleteTimeline(id: string): Promise<void> {
    await http.delete(`/timelines/${id}`)
  },
  async addClip(timelineId: string, clip: {
    video_file_id: string
    track?: number
    position?: number
    in_point?: number
    out_point?: number
    timeline_start?: number
    label?: string
    notes?: string
  }): Promise<TimelineClip> {
    const { data } = await http.post(`/timelines/${timelineId}/clips`, clip)
    return data
  },
  async updateClip(timelineId: string, clipId: string, updates: {
    track?: number
    position?: number
    in_point?: number
    out_point?: number
    timeline_start?: number
    label?: string
    notes?: string
  }): Promise<TimelineClip> {
    const { data } = await http.patch(`/timelines/${timelineId}/clips/${clipId}`, updates)
    return data
  },
  async removeClip(timelineId: string, clipId: string): Promise<void> {
    await http.delete(`/timelines/${timelineId}/clips/${clipId}`)
  },
  async reorderClips(timelineId: string, track: number, clipIds: string[]): Promise<void> {
    await http.post(`/timelines/${timelineId}/reorder`, { track, clip_ids: clipIds })
  },
  async exportTimelineCsv(timelineId: string, name: string): Promise<void> {
    const response = await http.get(`/timelines/${timelineId}/export-csv`, { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([response.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `timeline_${name.replace(/\s+/g, '_')}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  },
  async exportTimelineEdl(timelineId: string, name: string): Promise<void> {
    const response = await http.get(`/timelines/${timelineId}/export-edl`, { responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([response.data], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `timeline_${name.replace(/\s+/g, '_')}.edl`
    a.click()
    window.URL.revokeObjectURL(url)
  },

  // CLIP visual embedding
  async createClipEmbedJobs() {
    const { data } = await http.post('/dashboard/jobs/create-clip-embed')
    return data
  },

  // Media URLs (not axios calls – just URL helpers)
  thumbnailUrl(fileId: string): string {
    return `/api/media/thumbnail/${fileId}`
  },
  streamUrl(fileId: string): string {
    return `/api/media/stream/${fileId}`
  },

  // Thermal monitoring
  async getThermalStatus(): Promise<ThermalStatus> {
    const { data } = await http.get('/thermal/status')
    return data
  },
  async getThermalConfig(): Promise<ThermalConfig> {
    const { data } = await http.get('/thermal/config')
    return data
  },
  async updateThermalConfig(config: Partial<ThermalConfig>): Promise<ThermalConfig> {
    const { data } = await http.post('/thermal/config', config)
    return data
  },
  async getThermalEvents(n?: number): Promise<{ events: ThermalEvent[] }> {
    const { data } = await http.get('/thermal/events', { params: n ? { n } : undefined })
    return data
  },
  async setBatchSize(batchSize: number): Promise<{ batch_size: number }> {
    const { data } = await http.post('/thermal/batch', { batch_size: batchSize })
    return data
  },

  // Pipeline stage toggles (persistent CLIP / VLM enable)
  async getPipelineToggles(): Promise<{ clip_embed_enabled: boolean; caption_enabled: boolean }> {
    const { data } = await http.get('/dashboard/pipeline-toggles')
    return data
  },
  async setPipelineToggles(body: { clip_embed?: boolean; caption?: boolean }) {
    const { data } = await http.post('/dashboard/pipeline-toggles', body)
    return data as {
      toggles: { clip_embed_enabled: boolean; caption_enabled: boolean }
      paused: number
      requeued: number
      created: number
    }
  },

  // Coverage tree (per-root → per-folder → per-stage completion)
  async getCoverageTree() {
    const { data } = await http.get('/dashboard/coverage-tree')
    return data as {
      stages: string[]
      disabled_stages: string[]
      roots: Array<{
        root_id: string
        label: string
        path: string
        is_online: boolean
        file_count: number
        stage_counts: Record<string, number>
        skipped_counts: Record<string, number>
        folders: Array<{
          rel_path: string
          file_count: number
          stage_counts: Record<string, number>
          skipped_counts: Record<string, number>
        }>
      }>
    }
  },

  // Per-phase timing analytics
  async getPhaseAnalytics(scope: 'latest' | 'all_time' = 'latest') {
    const { data } = await http.get('/dashboard/phase-analytics', { params: { scope } })
    return data as {
      scope: string
      window_start: string | null
      window_end: string | null
      total_active_seconds: number
      phases: Array<{
        stage: string
        done_count: number
        active_seconds: number
        mean_seconds_per_job: number
        pct_of_total: number
        skipped_count: number
        skip_reasons: Record<string, number>
      }>
    }
  },
}