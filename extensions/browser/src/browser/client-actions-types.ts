/**
 * Shared result types for browser client action helpers.
 */
/** Generic success result for action endpoints. */
export type BrowserActionOk = { ok: true };

/** Success result carrying the affected tab and optional URL. */
export type BrowserActionTabResult = {
  ok: true;
  targetId: string;
  url?: string;
};

/** Success result carrying a filesystem output path. */
export type BrowserActionPathResult = {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
};
