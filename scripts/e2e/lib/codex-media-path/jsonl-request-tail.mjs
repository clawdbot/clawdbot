import fs from "node:fs";

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 1024;

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

export function createJsonlRequestTailer(filePath, options = {}) {
  const maxReadBytes = positiveInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  let offset = 0;
  let pending = "";
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
      if (!fs.existsSync(filePath)) {
        return requests;
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return requests;
      }
      if (stats.size < offset) {
        offset = 0;
        pending = "";
        requests = [];
      }
      if (stats.size === offset) {
        return requests;
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
        discardFirstLine = readSlice(filePath, start - 1, 1) !== "\n";
      }

      const text = readSlice(filePath, start, stats.size - start);
      offset = stats.size;
      if (!text) {
        return requests;
      }

      let chunk = pending + text;
      if (discardFirstLine) {
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex === -1) {
          pending = "";
          return requests;
        }
        chunk = chunk.slice(newlineIndex + 1);
      }

      const lines = chunk.split("\n");
      pending = lines.pop() ?? "";
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
