/**
 * The Hum Song icon: a note and a drum, since a hum is heard both as a melody and as a rhythm. SF Symbols has no drum,
 * so the Apple apps draw the same 24 by 24 shapes (EACore `HumSongGlyph`).
 */
export function HumSongIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false" style={{ verticalAlign: "-0.2em" }}>
      <ellipse cx="6.2" cy="16.2" rx="3.2" ry="2.4" transform="rotate(-20 6.2 16.2)" />
      <rect x="8.4" y="3" width="1.6" height="13" />
      <path d="M10 3 C12 4.2 13.5 5.2 13 8.2 C12.6 6.6 11.6 5.8 10 5.6 Z" />
      <path d="M12 15.5 A5 1.9 0 0 1 22 15.5 V20 A5 1.9 0 0 1 12 20 Z M13.4 15.5 A3.6 1.05 0 0 0 20.6 15.5 A3.6 1.05 0 0 0 13.4 15.5 Z" />
      <path d="M17.2 14.3 L21.6 8.4 L22.5 9 L18.1 14.9 Z" />
    </svg>
  );
}
