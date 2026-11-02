import type { DeviceColor } from "@debrief/core/device-colors";
import type { DeviceBadge as Badge } from "@debrief/core/meetings";

/** The device palette, readable on both themes (the badge mixes it with the page). */
export const DEVICE_SWATCH: Record<DeviceColor, string> = {
  violet: "oklch(62% 0.2 295)",
  pink: "oklch(64% 0.22 340)",
  green: "oklch(66% 0.17 150)",
  amber: "oklch(74% 0.15 75)",
  sky: "oklch(68% 0.13 230)",
  slate: "oklch(60% 0.03 250)",
};

/** Which computer a recording came from, as a colored badge with its label (Settings → Recorder & devices). */
export function DeviceBadge({ badge }: { badge: Badge | undefined }) {
  if (!badge) return null;
  return (
    <span className="badge badge-device" style={{ "--device": DEVICE_SWATCH[badge.color] } as React.CSSProperties}>
      {badge.label}
    </span>
  );
}
