import { Screen } from './Screen'

/**
 * Phase 1 stand-in. Every route resolves to one of these so the shell,
 * the tokens and the router can be verified before any feature exists.
 * Each is replaced by the real screen in phases 3–6.
 */
export function Placeholder({ frame, name }: { frame: string; name: string }) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <span className="text-eyebrow font-medium tracking-eyebrow text-accent-soft uppercase">
          Frame {frame}
        </span>
        <h1 className="text-md font-black tracking-tighter text-primary">{name}</h1>
        <p className="text-sm text-muted">Not built yet.</p>
      </div>
    </Screen>
  )
}
