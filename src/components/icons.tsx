/**
 * The two deck controls, as SVG.
 *
 * They used to be the text glyphs ✕ and ♥. That went wrong in two ways
 * at once: Roboto has no heart, so it fell through to whatever symbol
 * font the platform picked — which is why it looked stretched — and
 * matching the two by font-size never worked, because the glyphs fill
 * their em boxes differently. The heart had to be run at 38px against
 * the cross's 30px just to look comparable.
 *
 * As SVG both come from the same geometry family, share a 24x24 box, and
 * take one size, so neither can be elongated and neither can drift out
 * of step with the other. Both stroke at the same weight with the same
 * caps and joins, and both use currentColor so the button's own colour
 * still applies.
 */

type IconProps = {
  /** Rendered edge length in px. The same value for both, always. */
  size?: number
}

const SHARED = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const

/** Pass. */
export function PassIcon({ size = 32 }: IconProps) {
  return (
    <svg {...SHARED} width={size} height={size}>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  )
}

/**
 * Like.
 *
 * Filled rather than stroked, and that is not an inconsistency: a cross
 * has no interior, so it can only ever be a stroke. Pairing a stroked
 * cross with a solid heart is the conventional match, and it is what the
 * design's ♥ was. Same path family, same box, same size as the cross —
 * which is all that had gone wrong before.
 */
export function LikeIcon({ size = 32 }: IconProps) {
  return (
    <svg {...SHARED} width={size} height={size} fill="currentColor" stroke="none">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  )
}
