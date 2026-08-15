/** Metadata for a browser download saved under the configured output root. */
export type BrowserDownloadResult = {
  url: string;
  suggestedFilename: string;
  path: string;
};

/** Download metadata available before any bytes are written. */
export type BrowserDownloadCandidate = Omit<BrowserDownloadResult, "path">;
