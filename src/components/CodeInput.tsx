import { useRef } from 'react'

type CodeInputProps = {
  value: string
  onChange: (value: string) => void
  /** Fires when all four cells are filled, so the parent can submit. */
  onComplete?: () => void
}

export const CODE_LENGTH = 4

/**
 * Four cells, one character each (frame 01b).
 *
 * Codes are compared and stored uppercase, and the generator's alphabet
 * excludes 0/O and 1/I/L because codes get read aloud. Characters
 * outside A–Z and 2–9 are dropped rather than shown, so a stray space
 * from a paste never occupies a cell — but nothing tries to be clever
 * about O-for-zero, since neither character exists in a real code and
 * guessing would only mask the typo.
 */
export function CodeInput({ value, onChange, onComplete }: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([])

  const chars = value.padEnd(CODE_LENGTH, ' ').slice(0, CODE_LENGTH).split('')

  function clean(raw: string) {
    return raw.toUpperCase().replace(/[^A-Z2-9]/g, '')
  }

  function commit(next: string) {
    const trimmed = next.slice(0, CODE_LENGTH)
    onChange(trimmed)
    if (trimmed.length === CODE_LENGTH) onComplete?.()
  }

  function focusCell(index: number) {
    refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, index))]?.focus()
  }

  function handleChange(index: number, raw: string) {
    const cleaned = clean(raw)
    if (cleaned === '') return

    // Typing over a filled cell replaces it, so take the last character
    // rather than the first: the browser hands us "K9" when someone
    // types 9 into a cell already holding K.
    const char = cleaned[cleaned.length - 1]!

    const next = value.padEnd(CODE_LENGTH, ' ').split('')
    next[index] = char
    commit(next.join('').trimEnd())

    if (index < CODE_LENGTH - 1) focusCell(index + 1)
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault()

      const next = value.padEnd(CODE_LENGTH, ' ').split('')

      if (next[index] && next[index] !== ' ') {
        // Clear this cell and stay put.
        next[index] = ' '
        onChange(next.join('').trimEnd())
      } else if (index > 0) {
        // Already empty, so eat the previous one and step back.
        next[index - 1] = ' '
        onChange(next.join('').trimEnd())
        focusCell(index - 1)
      }
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusCell(index - 1)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusCell(index + 1)
    }
  }

  /** Pasting a whole code fills every cell, which is how a shared code arrives. */
  function handlePaste(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    const pasted = clean(event.clipboardData.getData('text'))
    if (pasted === '') return

    const next = value.padEnd(CODE_LENGTH, ' ').split('')
    for (let i = 0; i < pasted.length && index + i < CODE_LENGTH; i++) {
      next[index + i] = pasted[i]!
    }

    const joined = next.join('').trimEnd()
    commit(joined)
    focusCell(Math.min(index + pasted.length, CODE_LENGTH - 1))
  }

  return (
    <div className="codegrid">
      {chars.map((char, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el
          }}
          className="codecell tap-exempt"
          value={char.trim()}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={(e) => handlePaste(index, e)}
          onFocus={(e) => e.target.select()}
          // text, not numeric: codes are letters and digits, and a
          // numeric keypad would hide half the alphabet.
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={2}
          aria-label={`Lobby code character ${index + 1}`}
        />
      ))}
    </div>
  )
}
