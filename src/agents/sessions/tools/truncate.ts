/**
 * Session tool truncation facade.
 *
 * Re-exports the shared harness truncation utilities so session tools and agent
 * harness rendering use one byte/line truncation contract.
 */
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
  type TruncationOptions,
  type TruncationResult,
} from "../../../../packages/agent-core/src/harness/utils/truncate.js";
