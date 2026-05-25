import fs from "node:fs";

const [statsFile, maxMemoryRaw, maxCpuRaw, label = "docker"] = process.argv.slice(2);
const maxMemoryMiB = Number(maxMemoryRaw);
const maxCpuPercent = Number(maxCpuRaw);

function assertFiniteLimit(value, raw, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number. Got: ${JSON.stringify(raw)}`);
  }
}

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
  const parsed = Number(String(raw || "").replace(/%$/u, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertSampleValue(value, raw, name, label) {
  if (value === undefined) {
    throw new Error(
      `docker stats sample for ${label} had invalid ${name}: ${JSON.stringify(raw)}`,
    );
  }
}

const lines = fs.existsSync(statsFile)
  ? fs.readFileSync(statsFile, "utf8").split(/\r?\n/u).filter(Boolean)
  : [];
let maxObservedMemoryMiB = 0;
let maxObservedCpuPercent = 0;
let parsedSamples = 0;

assertFiniteLimit(maxMemoryMiB, maxMemoryRaw, "max memory MiB");
assertFiniteLimit(maxCpuPercent, maxCpuRaw, "max CPU percent");

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`docker stats sample for ${label} was not valid JSON`);
  }
  const observedMemoryMiB = parseMemoryMiB(parsed.MemUsage);
  const observedCpuPercent = parseCpuPercent(parsed.CPUPerc);
  assertSampleValue(observedMemoryMiB, parsed.MemUsage, "MemUsage", label);
  assertSampleValue(observedCpuPercent, parsed.CPUPerc, "CPUPerc", label);
  parsedSamples += 1;
  maxObservedMemoryMiB = Math.max(maxObservedMemoryMiB, observedMemoryMiB);
  maxObservedCpuPercent = Math.max(maxObservedCpuPercent, observedCpuPercent);
}

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
