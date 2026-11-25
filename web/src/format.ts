/** 99280 as "99,280". */
export const count = (value: number) => value.toLocaleString("en-US");

/** A share from 0 to 1 as "57%". */
export const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Milliseconds as "212 ms", "2.2 s" or "3 min 12 s". */
export function duration(ms: number): string {
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Names as "bank", "bank and hotel" or "bank, hotel and school". */
export const list = (names: string[]) =>
  new Intl.ListFormat("en-GB").format(names);
