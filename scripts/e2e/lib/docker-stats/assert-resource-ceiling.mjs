// Resource ceiling assertions for Docker E2E stats output.
import fs from "node:fs";

const [statsFile, maxMemoryRaw, maxCpuRaw, label = "docker"] = process.argv.slice(2);
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const MAX_STATS_SAMPLE_LINE_BYTES = 1024 * 1024;

function parseFiniteLimit(raw, name) {
  const text = String(raw ?? "").trim();
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(text)) {
    throw new Error(
      `${name} must be a finite non-negative number in decimal notation. Got: ${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${name} must be a finite non-negative number in decimal notation. Got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

const maxMemoryMiB = parseFiniteLimit(maxMemoryRaw, "max memory MiB");
const maxCpuPercent = parseFiniteLimit(maxCpuRaw, "max CPU percent");

function parseMemoryMiB(raw) {
  const value =
    String(raw || "")
      .split("/")[0]
      ?.trim() || "";
  const match = /^([0-9.]+)\s*([KMGT]?i?B)$/iu.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const unit = match[2].toLowerCase();
  if (unit === "b") {
    return amount / 1024 / 1024;
  }
  if (unit === "kb" || unit === "kib") {
    return amount / 1024;
  }
  if (unit === "mb" || unit === "mib") {
    return amount;
  }
  if (unit === "gb" || unit === "gib") {
    return amount * 1024;
  }
  if (unit === "tb" || unit === "tib") {
    return amount * 1024 * 1024;
  }
  return undefined;
}

function parseCpuPercent(raw) {
  const text = String(raw ?? "").trim();
  const valueText = text.endsWith("%") ? text.slice(0, -1).trim() : text;
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(valueText)) {
    return undefined;
  }
  const parsed = Number(valueText);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTerminalZeroMemorySample(raw) {
  const parts = String(raw || "").split("/");
  if (parts.length !== 2) {
    return false;
  }
  return parts.every((part) => parseMemoryMiB(part.trim()) === 0);
}

function assertSampleValue(value, raw, name, labelLocal) {
  if (value === undefined) {
    throw new Error(
      `docker stats sample for ${labelLocal} had invalid ${name}: ${JSON.stringify(raw)}`,
    );
  }
  if (name === "MemUsage" && value <= 0) {
    throw new Error(
      `docker stats sample for ${labelLocal} had non-positive ${name}: ${JSON.stringify(raw)}`,
    );
  }
}

async function scanStatsFileLines(file, onLine) {
  if (!fs.existsSync(file)) {
    return;
  }
  const input = fs.createReadStream(file, { encoding: "utf8" });
  let pending = "";
  let pendingBytes = 0;
  let skipLineFeedAfterCarriageReturn = false;

  const appendSegment = (segment) => {
    if (!segment) {
      return;
    }
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (pendingBytes + segmentBytes > MAX_STATS_SAMPLE_LINE_BYTES) {
      throw new Error(
        `docker stats sample for ${label} exceeded ${MAX_STATS_SAMPLE_LINE_BYTES} bytes`,
      );
    }
    pending += segment;
    pendingBytes += segmentBytes;
  };
  const emitPendingLine = () => {
    const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
    pending = "";
    pendingBytes = 0;
    if (line) {
      onLine(line);
    }
  };

  for await (const chunk of input) {
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      if (skipLineFeedAfterCarriageReturn) {
        skipLineFeedAfterCarriageReturn = false;
        if (code === 10) {
          start = index + 1;
          continue;
        }
      }
      if (code !== 10 && code !== 13) {
        continue;
      }
      appendSegment(chunk.slice(start, index));
      emitPendingLine();
      skipLineFeedAfterCarriageReturn = code === 13;
      start = index + 1;
    }
    appendSegment(chunk.slice(start));
  }
  if (pending) {
    emitPendingLine();
  }
}

let maxObservedMemoryMiB = 0;
let maxObservedCpuPercent = 0;
let parsedSamples = 0;

await scanStatsFileLines(statsFile, (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`docker stats sample for ${label} was not valid JSON`);
  }
  const observedMemoryMiB = parseMemoryMiB(parsed.MemUsage);
  const observedCpuPercent = parseCpuPercent(parsed.CPUPerc);
  // Docker can emit 0B / 0B after the target container exits; it proves
  // lifecycle timing, not resource usage. Keep the real captured samples.
  if (isTerminalZeroMemorySample(parsed.MemUsage)) {
    return;
  }
  assertSampleValue(observedMemoryMiB, parsed.MemUsage, "MemUsage", label);
  assertSampleValue(observedCpuPercent, parsed.CPUPerc, "CPUPerc", label);
  parsedSamples += 1;
  maxObservedMemoryMiB = Math.max(maxObservedMemoryMiB, observedMemoryMiB);
  maxObservedCpuPercent = Math.max(maxObservedCpuPercent, observedCpuPercent);
});

console.log(
  `${label} resource peak: memory=${maxObservedMemoryMiB.toFixed(1)}MiB cpu=${maxObservedCpuPercent.toFixed(1)}% samples=${parsedSamples}`,
);
if (parsedSamples === 0) {
  throw new Error(`no docker stats samples captured for ${label}`);
}
if (maxObservedMemoryMiB > maxMemoryMiB) {
  throw new Error(
    `${label} memory peak ${maxObservedMemoryMiB.toFixed(1)}MiB exceeded ${maxMemoryMiB}MiB`,
  );
}
if (maxObservedCpuPercent > maxCpuPercent) {
  throw new Error(
    `${label} CPU peak ${maxObservedCpuPercent.toFixed(1)}% exceeded ${maxCpuPercent}%`,
  );
}
