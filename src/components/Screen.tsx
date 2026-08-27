import type { CSSProperties, ReactNode } from 'react'

type Gutter = 'screen' | 'deck' | 'none'

const GUTTER: Record<Gutter, string> = {
  screen: 'var(--gutter-screen)',
  deck: 'var(--gutter-deck)', // the swipe screen wants more card room
  none: '0px',
}

type ScreenProps = {
  children: ReactNode
  gutter?: Gutter
  className?: string
}

/**
 * Full-height screen shell. Owns the two things every screen needs and
 * no screen should re-solve: real safe-area insets and the side gutter.
 *
 * Height is 100dvh, not 100vh — see PLAN.md §13.
 */
export function Screen({ children, gutter = 'screen', className = '' }: ScreenProps) {
  const pad = GUTTER[gutter]

  const style: CSSProperties = {
    paddingTop: 'var(--inset-top)',
    paddingBottom: 'var(--inset-bottom)',
    paddingLeft: `calc(var(--inset-left) + ${pad})`,
    paddingRight: `calc(var(--inset-right) + ${pad})`,
  }

  return (
    <div
      style={style}
      className={`flex min-h-[100dvh] flex-1 flex-col bg-page ${className}`}
    >
      {children}
    </div>
  )
}
