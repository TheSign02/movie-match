/** The design shows two chips; three is the cap agreed for real data. */
const MAX_CHIPS = 3

type GenreChipsProps = {
  genres: string[] | null
  /** Smaller chips for the results grid, where a tile is half a screen wide. */
  small?: boolean
}

/**
 * Genre chips, the design's `.chip` used for what it was drawn for.
 *
 * TMDB returns genres roughly primary-first, so the top three are the
 * useful ones — and a film with six of them would otherwise wrap the
 * byline onto three lines.
 */
export function GenreChips({ genres, small = false }: GenreChipsProps) {
  const shown = (genres ?? []).slice(0, MAX_CHIPS)
  if (shown.length === 0) return null

  return (
    <span className={`chips${small ? ' chips--sm' : ''}`}>
      {shown.map((genre) => (
        <span className="chip" key={genre}>
          {genre}
        </span>
      ))}
    </span>
  )
}
