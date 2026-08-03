// Tails JSONL request logs for Codex media-path E2E assertions.
import {
  createIncrementalLineReader,
  resolvePositiveInteger,
} from "../incremental-line-reader.mjs";

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 1024;

export function createJsonlRequestTailer(filePath, options = {}) {
  const maxReadBytes = resolvePositiveInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const historyLimit = resolvePositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  const reader = createIncrementalLineReader(filePath, { maxReadBytes });
  let requests = [];

  function parseLine(line) {
    try {
      return JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid app-server JSONL at ${filePath}: ${message}`, { cause: error });
    }
  }

  return {
    read() {
      const { lines, reset } = reader.readLines();
      if (reset) {
        requests = [];
      }
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        requests.push(parseLine(line));
      }
      if (requests.length > historyLimit) {
        requests = requests.slice(-historyLimit);
      }
      return requests;
    },
  };
}
