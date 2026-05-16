/**
 * Splash screen with a wavy "hello paul" greeting on app cold-load.
 *
 * Fades in over the app, animates the letters in a staggered wave, then
 * fades out and unmounts itself. Clicking anywhere dismisses it early.
 * The app underneath renders normally the whole time so the splash is
 * purely cosmetic — nothing about it gates app readiness.
 */
import { useEffect, useState } from 'react'

const GREETING = 'hello paul'
const HOLD_MS = 2000        // how long the wave plays before starting to fade
const FADE_MS = 480         // matches the intro-fade-out keyframe in index.css

export function IntroSplash() {
  const [phase, setPhase] = useState<'showing' | 'fading' | 'gone'>('showing')

  useEffect(() => {
    if (phase !== 'showing') return
    const t = window.setTimeout(() => setPhase('fading'), HOLD_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  useEffect(() => {
    if (phase !== 'fading') return
    const t = window.setTimeout(() => setPhase('gone'), FADE_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  if (phase === 'gone') return null

  return (
    <div
      className={phase === 'fading' ? 'intro-splash fading' : 'intro-splash'}
      onClick={() => setPhase('fading')}
      aria-hidden="true"
    >
      <div className="intro-splash-text">
        {Array.from(GREETING).map((ch, i) => (
          <span
            key={i}
            className={ch === ' ' ? 'intro-splash-letter space' : 'intro-splash-letter'}
            style={{ animationDelay: `${i * 90}ms` }}
          >
            {ch === ' ' ? ' ' : ch}
          </span>
        ))}
      </div>
    </div>
  )
}
