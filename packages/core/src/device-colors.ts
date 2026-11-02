/** The colors a device's badge can take. On its own so the browser can import it without the database code. */
export const DEVICE_COLORS = ["violet", "pink", "green", "amber", "sky", "slate"] as const;
export type DeviceColor = (typeof DEVICE_COLORS)[number];
