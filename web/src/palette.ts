import { OWN_COLORS } from "./history.ts";

/**
 * The CSS color of a color number: 0 to 7 are the colors that tenants get for
 * themselves, everything above is the shared gray. The values are in
 * styles.css, once for a light and once for a dark screen.
 */
export const colorOf = (color: number) =>
  `var(--tenant-${Math.min(color, OWN_COLORS) + 1})`;
