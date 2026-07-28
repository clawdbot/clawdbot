import { stableStringify } from "../agents/stable-stringify.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import type { CronJob } from "./types.js";

export function resolveCronListSnapshotRevision(jobs: readonly CronJob[]): string {
  // Cover the full sorted result, not only one page, so clients can reject
  // offset pages produced before and after any mutation.
  return `sha256:${sha256Base64Url(stableStringify(jobs))}`;
}
