import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Thermometer, ChevronDown, ChevronUp, Activity } from 'lucide-react'
import toast from 'react-hot-toast'
import { api, ThermalStatus, ThermalEvent } from '@/api/client'
import { cn } from '@/lib/utils'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTemp(t: number | null | undefined): string {
  if (t == null) return '—'
  return `${t.toFixed(1)}°C`
}

function fmtLoad(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(1)}%`
}

function fmtClock(v: number | null | undefined): string {
  if (v == null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)} GHz` : `${v.toFixed(0)} MHz`
}

function fmtSec(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function timeSince(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  return `${Math.floor(diff / 60)}m ago`
}

// ─── State badge ─────────────────────────────────────────────────────────────

const STATE_STYLES: Record<string, string> = {
  optimal:             'bg-green-900/40 text-green-400 border border-green-800/40',
  warm:                'bg-yellow-900/40 text-yellow-300 border border-yellow-800/40',
  cooling:             'bg-orange-900/40 text-orange-300 border border-orange-800/40',
  throttling_detected: 'bg-red-900/50 text-red-400 border border-red-800/50',
  recovering:          'bg-blue-900/40 text-blue-400 border border-blue-800/40',
  monitor_only:        'bg-zinc-800 text-zinc-400 border border-zinc-700',
  sensor_unavailable:  'bg-zinc-800/60 text-zinc-500 border border-zinc-700/40',
}

const STATE_LABELS: Record<string, string> = {
  optimal:             'Optimal',
  warm:                'Warm',
  cooling:             'Cooling',
  throttling_detected: 'Throttling',
  recovering:          'Recovering',
  monitor_only:        'Monitor Only',
  sensor_unavailable:  'No Sensor',
}

function StateBadge({ state }: { state: string }) {
  const cls = STATE_STYLES[state] ?? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
  return (
    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', cls)}>
      {STATE_LABELS[state] ?? state}
    </span>
  )
}

// ─── Provider badge ───────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: string }) {
  const styles: Record<string, string> = {
    hwinfo:         'bg-violet-900/40 text-violet-400',
    lhm:            'bg-sky-900/40 text-sky-400',
    'nvidia-smi':   'bg-green-900/40 text-green-400',
    unavailable:    'bg-zinc-800 text-zinc-500',
  }
  const labels: Record<string, string> = {
    hwinfo:         'HWiNFO',
    lhm:            'LHM',
    'nvidia-smi':   'GPU',
    unavailable:    'No Sensor',
  }
  return (
    <span className={cn('text-xs px-1.5 py-0.5 rounded font-mono', styles[provider] ?? styles.unavailable)}>
      {labels[provider] ?? provider}
    </span>
  )
}

// ─── Event log row ────────────────────────────────────────────────────────────

const EVT_COLORS: Record<string, string> = {
  throttle_start:    'text-red-400',
  throttle_end:      'text-green-400',
  backoff:           'text-orange-400',
  recovery:          'text-blue-400',
  sensor_switch:     'text-violet-400',
  sensor_fail:       'text-red-500',
  threshold_crossed: 'text-yellow-400',
  state_change:      'text-zinc-400',
}

function EventRow({ evt }: { evt: ThermalEvent }) {
  const color = EVT_COLORS[evt.event_type] ?? 'text-zinc-500'
  const ts = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="text-zinc-600 font-mono text-xs flex-shrink-0 w-20">{ts}</span>
      <span className={cn('text-xs flex-1', color)}>{evt.message}</span>
      {evt.temp != null && (
        <span className="text-xs text-zinc-500 font-mono flex-shrink-0">{fmtTemp(evt.temp)}</span>
      )}
    </div>
  )
}

// ─── Temp limit options ───────────────────────────────────────────────────────

const LIMIT_OPTIONS = [
  { label: 'Auto',             value: 999 },
  { label: '70°C',             value: 70  },
  { label: '75°C',             value: 75  },
  { label: '80°C',             value: 80  },
  { label: '85°C',             value: 85  },
  { label: '90°C',             value: 90  },
  { label: 'Off / Monitor Only', value: -1 },
]

const BATCH_OPTIONS = [
  { label: '50 jobs',          value: 50  },
  { label: '100 jobs',         value: 100 },
  { label: '200 jobs',         value: 200 },
  { label: 'All in queue (0)', value: 0   },
]

// ─── Main component ───────────────────────────────────────────────────────────

export function ThermalCard() {
  const qc = useQueryClient()
  const [showEvents, setShowEvents] = useState(false)

  const { data: status } = useQuery<ThermalStatus>(
    'thermal-status',
    () => api.getThermalStatus(),
    { refetchInterval: 3000, retry: false }
  )

  const { data: eventsData } = useQuery(
    'thermal-events',
    () => api.getThermalEvents(10),
    { refetchInterval: 5000, enabled: showEvents, retry: false }
  )

  const configMut = useMutation(
    (cfg: Parameters<typeof api.updateThermalConfig>[0]) => api.updateThermalConfig(cfg),
    {
      onSuccess: () => { qc.invalidateQueries('thermal-status') },
      onError: () => { toast.error('Failed to update thermal config') },
    }
  )

  const batchMut = useMutation(
    (n: number) => api.setBatchSize(n),
    {
      onSuccess: (res) => { toast.success(`Batch limit set to ${res.batch_size === 0 ? 'unlimited' : res.batch_size}`) },
      onError: () => { toast.error('Failed to set batch size') },
    }
  )

  // Determine current limit selector value
  const currentLimitVal = (() => {
    if (!status) return 999
    if (status.config.monitor_only || status.config.selected_limit === -1) return -1
    if (status.config.auto_mode || status.config.selected_limit === 999) return 999
    return status.config.selected_limit
  })()

  function handleLimitChange(val: number) {
    configMut.mutate({
      selected_limit: val,
      auto_mode: val === 999,
      monitor_only: val === -1,
    })
  }

  const unavailable = !status || status.provider === 'unavailable'

  return (
    <div className="card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Thermometer size={13} className="text-accent flex-shrink-0" />
        <p className="label">Thermals</p>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {status && <ProviderBadge provider={status.provider} />}
          {status?.last_update && (
            <span className="text-xs text-zinc-600">{timeSince(status.last_update)}</span>
          )}
        </div>
      </div>

      {/* State badge + message */}
      {status && (
        <div className="flex items-center gap-2 flex-wrap">
          <StateBadge state={status.state} />
          <span className="text-xs text-zinc-500 italic">{status.status_message}</span>
        </div>
      )}

      {/* Temperature row */}
      <div className="grid grid-cols-4 gap-2">
        <div className="flex flex-col">
          <span className="text-xs text-zinc-500 mb-0.5">Current</span>
          <span className={cn(
            'text-lg font-mono font-semibold leading-none',
            unavailable ? 'text-zinc-600' :
            (status?.current_temp ?? 0) >= 90 ? 'text-red-400' :
            (status?.current_temp ?? 0) >= 80 ? 'text-orange-400' :
            (status?.current_temp ?? 0) >= 70 ? 'text-yellow-400' : 'text-zinc-200'
          )}>
            {fmtTemp(status?.current_temp)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-zinc-500 mb-0.5">Avg 5m</span>
          <span className="text-sm font-mono text-zinc-300 leading-none mt-0.5">
            {fmtTemp(status?.rolling_avg)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-zinc-500 mb-0.5">Session</span>
          <span className="text-sm font-mono text-zinc-400 leading-none mt-0.5">
            {fmtTemp(status?.session_avg)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-zinc-500 mb-0.5">Peak</span>
          <span className="text-sm font-mono text-zinc-400 leading-none mt-0.5">
            {fmtTemp(status?.peak_temp)}
          </span>
        </div>
      </div>

      {/* Load + clock row */}
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <Activity size={11} className="text-zinc-500" />
          <span className="text-zinc-500">Load:</span>
          <span className="font-mono text-zinc-300">{fmtLoad(status?.cpu_load)}</span>
        </div>
        {status?.effective_clock_mhz != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500">Clock:</span>
            <span className="font-mono text-zinc-300">{fmtClock(status.effective_clock_mhz)}</span>
          </div>
        )}
        {status && status.current_delay_sec > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-zinc-500">Pacing:</span>
            <span className="font-mono text-orange-400">{status.current_delay_sec.toFixed(1)}s delay</span>
          </div>
        )}
      </div>

      {/* Throttling row */}
      {status && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-zinc-500">Throttling:</span>
          {status.is_throttling ? (
            <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 font-medium">Yes</span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">No</span>
          )}
          {status.throttle_source !== 'unknown' && (
            <span className="text-zinc-600">({status.throttle_source})</span>
          )}
          {status.time_throttling_sec > 0 && (
            <span className="text-zinc-500 ml-auto">
              {fmtSec(status.time_throttling_sec)} throttled this session
            </span>
          )}
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center gap-2 pt-1 border-t border-surface-4">
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs text-zinc-500">Thermal Limit</label>
          <select
            className="text-xs bg-surface-3 border border-surface-4 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-accent/50"
            value={currentLimitVal}
            onChange={(e) => handleLimitChange(Number(e.target.value))}
            disabled={configMut.isLoading}
          >
            {LIMIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label className="text-xs text-zinc-500">Batch Size</label>
          <select
            className="text-xs bg-surface-3 border border-surface-4 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-accent/50"
            defaultValue={0}
            onChange={(e) => batchMut.mutate(Number(e.target.value))}
            disabled={batchMut.isLoading}
          >
            {BATCH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Collapsible event log */}
      <div>
        <button
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-full"
          onClick={() => setShowEvents((v) => !v)}
        >
          {showEvents ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          Event log
          {eventsData?.events?.length ? (
            <span className="ml-1 text-zinc-600">({eventsData.events.length})</span>
          ) : null}
        </button>

        {showEvents && (
          <div className="mt-2 space-y-0.5 max-h-36 overflow-y-auto pr-1">
            {eventsData?.events?.length ? (
              eventsData.events.map((evt, i) => <EventRow key={i} evt={evt} />)
            ) : (
              <p className="text-xs text-zinc-600 py-1">No events yet</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
