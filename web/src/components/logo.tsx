import { useId } from "react";

/** The Debrief tile: a voice waveform becoming lines of transcript. */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(78% 0.13 200)" />
          <stop offset="1" stopColor="oklch(48% 0.11 208)" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}-fill)`} />
      <rect width="32" height="32" rx="9" fill={`url(#${id}-sheen)`} />
      <LogoGlyph />
    </svg>
  );
}

export function LogoGlyph() {
  return (
    <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none">
      <path d="M8 10.5v2M12 7.5v8M16 5v13M20 8.5v6M24 10v3" />
      <path d="M8 22.4h16" strokeOpacity="0.72" />
      <path d="M8 26.8h10" strokeOpacity="0.45" />
    </g>
  );
}
