import { OWN_COLORS } from "./history.ts";

/** Colors live in styles.css. 8 and up is the shared grey. */
export const colorOf = (color: number) =>
  `var(--tenant-${Math.min(color, OWN_COLORS) + 1})`;
