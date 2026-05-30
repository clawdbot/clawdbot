import {
  createIncrementalLineReader,
  resolvePositiveInteger,
} from "../incremental-line-reader.mjs";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_TAIL_LINE_LIMIT = 160;
const RELOAD_NEEDLE = "config change detected; evaluating reload";
const RESTART_NEEDLE = "config change requires gateway restart";

export function inspectConfigReloadLogLine(line) {
  return {
    reload: line.includes(RELOAD_NEEDLE),
    restart: line.includes(RESTART_NEEDLE),
  };
}

export function createConfigReloadLogScanner(logPath, options = {}) {
  const maxReadBytes = resolvePositiveInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const tailLineLimit = resolvePositiveInteger(options.tailLineLimit, DEFAULT_TAIL_LINE_LIMIT);
  const reader = createIncrementalLineReader(logPath, { maxReadBytes });
  let tailLines = [];
  const reloadLines = [];
  const restartLines = [];

  return {
    scan() {
      const { lines, reset } = reader.readLines();
      if (reset) {
        tailLines = [];
        reloadLines.length = 0;
        restartLines.length = 0;
      }
      for (const line of lines) {
        const trimmed = line.replace(/\r$/u, "");
        tailLines.push(trimmed);
        const match = inspectConfigReloadLogLine(trimmed);
        if (match.reload) {
          reloadLines.push(trimmed);
        }
        if (match.restart) {
          restartLines.push(trimmed);
        }
      }
      if (tailLines.length > tailLineLimit) {
        tailLines = tailLines.slice(-tailLineLimit);
      }
      return { reloadLines, restartLines, tailLines };
    },
  };
}
