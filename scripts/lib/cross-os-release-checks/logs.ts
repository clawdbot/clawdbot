import { closeSync, openSync, statSync } from "node:fs";
import { readFileWindowFullySync } from "../../../src/infra/file-read.ts";
import { CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES } from "./config.ts";

export function readLogFileSize(logPath: string) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export function readLogTextSince(logPath: string, offsetBytes: number) {
  return readLogTextWindow(logPath, {
    offsetBytes,
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

export function readLogTextTail(logPath: string) {
  return readLogTextWindow(logPath, {
    maxBytes: CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES,
  });
}

export function readLogTextWindow(
  logPath: string,
  options: { maxBytes?: number; offsetBytes?: number } = {},
) {
  const maxBytes = Math.max(
    1,
    Math.floor(options.maxBytes ?? CROSS_OS_AGENT_LOG_FALLBACK_TAIL_BYTES),
  );
  const offsetBytes =
    typeof options.offsetBytes === "number" && Number.isFinite(options.offsetBytes)
      ? Math.max(0, Math.floor(options.offsetBytes))
      : 0;
  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }

  const tailStart = Math.max(0, stat.size - maxBytes);
  const start = Math.min(stat.size, Math.max(offsetBytes, tailStart));
  const length = stat.size - start;
  if (length <= 0) {
    return "";
  }

  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readFileWindowFullySync(fd, buffer, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
