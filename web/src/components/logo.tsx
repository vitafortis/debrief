/** The Debrief mark: seven waveform bars, one shade of blue each, dark to light. */
const BARS = [
  { x: 4, y: 22, h: 20, fill: "fill-[#17559b] dark:fill-[#3a75bf]" },
  { x: 12.4, y: 15, h: 34, fill: "fill-[#3166a8] dark:fill-[#4d84c8]" },
  { x: 20.8, y: 6, h: 52, fill: "fill-[#4778b6] dark:fill-[#6093d2]" },
  { x: 29.2, y: 13, h: 38, fill: "fill-[#5d8ac3] dark:fill-[#73a1dc]" },
  { x: 37.6, y: 9, h: 46, fill: "fill-[#739cd0] dark:fill-[#86b0e5]" },
  { x: 46, y: 18, h: 28, fill: "fill-[#89aede] dark:fill-[#99bfef]" },
  { x: 54.4, y: 25, h: 14, fill: "fill-[#a0c0eb] dark:fill-[#accdf8]" },
];

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      {BARS.map((b) => (
        <rect key={b.x} x={b.x} y={b.y} width="5.6" height={b.h} rx="2.8" className={b.fill} />
      ))}
    </svg>
  );
}
