/**
 * Single source of truth for search-mode metadata.
 *
 * The backend dispatches on the mode string in `app/search/engine.py:search()`.
 * The mode list, display labels, and placeholders previously lived inline in
 * `pages/Search.tsx`; moving them here lets other components (command palette,
 * deep-link buttons in reel cards, batch-tag flows) reuse the same metadata
 * without copying the table.
 *
 * SearchMode is also accepted as the union type for `api.SearchRequest.mode`.
 */

export type SearchMode =
  | 'semantic'
  | 'keyword'
  | 'hybrid'
  | 'visual'
  | 'caption'
  | 'multimodal'

export const ALL_SEARCH_MODES: readonly SearchMode[] = [
  'semantic',
  'keyword',
  'hybrid',
  'visual',
  'caption',
  'multimodal',
] as const

export const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  semantic:   'Semantic',
  keyword:    'Keyword',
  hybrid:     'Hybrid',
  visual:     'Visual (CLIP)',
  caption:    'Caption (VLM)',
  multimodal: 'Multimodal',
}

export const SEARCH_MODE_PLACEHOLDERS: Record<SearchMode, string> = {
  semantic:   'sunrise drone shot mountains, person talking indoors, clips mentioning Syria…',
  keyword:    'exact words from transcript or filename…',
  hybrid:     'mixes semantic + keyword — best for named entities…',
  visual:     'talking head shot, aerial coastline, person explaining something, drone over city…',
  caption:    'wide shot of empty diner at dusk, two people arguing in a kitchen…',
  multimodal: 'describe a moment — speech, visual, and caption are all searched at once…',
}

/**
 * True when the mode attaches FrameMatch entries (visual / caption /
 * multimodal). Used to decide whether to render frame-timestamp links and
 * deep-link to specific moments in the file.
 */
export function isVisualMode(m: SearchMode): boolean {
  return m === 'visual' || m === 'caption' || m === 'multimodal'
}

/**
 * Narrow an arbitrary string (e.g. from localStorage) into a SearchMode.
 * Returns null when the input doesn't match a known mode.
 */
export function asSearchMode(raw: string | null | undefined): SearchMode | null {
  if (!raw) return null
  return ALL_SEARCH_MODES.includes(raw as SearchMode) ? (raw as SearchMode) : null
}

/**
 * Compare this file's mode list against what the backend reports at
 * `/api/search/modes`. Emits a console warning on drift — adding a mode in
 * the engine without updating this list (or vice versa) silently breaks the
 * Search UI; the warning surfaces it in one place.
 *
 * Called once at app boot from main.tsx. Failures (404, network error)
 * are swallowed — backend without the endpoint is treated as "no info."
 */
export async function checkSearchModesInSync(
  fetchBackend: () => Promise<{ modes: string[] }>
): Promise<void> {
  try {
    const { modes: backend } = await fetchBackend()
    const frontend = [...ALL_SEARCH_MODES]
    const missingOnFrontend = backend.filter((m) => !frontend.includes(m as SearchMode))
    const missingOnBackend = frontend.filter((m) => !backend.includes(m))
    if (missingOnFrontend.length || missingOnBackend.length) {
      // eslint-disable-next-line no-console
      console.warn(
        '[search-modes] backend/frontend drift detected\n' +
        (missingOnFrontend.length ? `  backend has but frontend doesn't: ${missingOnFrontend.join(', ')}\n` : '') +
        (missingOnBackend.length  ? `  frontend has but backend doesn't: ${missingOnBackend.join(', ')}\n` : '') +
        'Update frontend/src/lib/search-modes.ts and backend/app/search/engine.py:SEARCH_MODES together.'
      )
    }
  } catch {
    // Backend may be down or pre-endpoint — silent.
  }
}
