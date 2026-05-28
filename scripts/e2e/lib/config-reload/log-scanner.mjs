import fs from "node:fs";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_TAIL_LINE_LIMIT = 160;
const RELOAD_NEEDLE = "config change detected; evaluating reload";
const RESTART_NEEDLE = "config change requires gateway restart";

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readSlice(filePath, start, length) {
  if (length <= 0) {
    return "";
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectConfigReloadLogLine(line) {
  return {
    reload: line.includes(RELOAD_NEEDLE),
    restart: line.includes(RESTART_NEEDLE),
  };
}

export function createConfigReloadLogScanner(logPath, options = {}) {
  const maxReadBytes = positiveInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const tailLineLimit = positiveInteger(options.tailLineLimit, DEFAULT_TAIL_LINE_LIMIT);
  let offset = 0;
  let pending = "";
  let tailLines = [];
  const reloadLines = [];
  const restartLines = [];

  return {
    scan() {
      if (!fs.existsSync(logPath)) {
        return { reloadLines, restartLines, tailLines };
      }

      const stats = fs.statSync(logPath);
      if (!stats.isFile()) {
        return { reloadLines, restartLines, tailLines };
      }
      if (stats.size < offset) {
        offset = 0;
        pending = "";
        tailLines = [];
        reloadLines.length = 0;
        restartLines.length = 0;
      }
      if (stats.size === offset) {
        return { reloadLines, restartLines, tailLines };
      }

      let start = offset;
      let discardFirstLine = false;
      let clamped = false;
      if (start === 0 && stats.size > maxReadBytes) {
        start = stats.size - maxReadBytes;
        pending = "";
        clamped = true;
      } else if (stats.size - start > maxReadBytes) {
        start = stats.size - maxReadBytes;
        pending = "";
        clamped = true;
      }
      if (clamped && start > 0) {
        discardFirstLine = readSlice(logPath, start - 1, 1) !== "\n";
      }

      const text = readSlice(logPath, start, stats.size - start);
      offset = stats.size;
      let chunk = pending + text;
      if (discardFirstLine) {
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex === -1) {
          pending = "";
          return { reloadLines, restartLines, tailLines };
        }
        chunk = chunk.slice(newlineIndex + 1);
      }

      const lines = chunk.split("\n");
      pending = lines.pop() ?? "";
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
