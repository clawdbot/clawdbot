import fs from "node:fs";

const [statsFile, maxMemoryRaw, maxCpuRaw, label = "docker"] = process.argv.slice(2);
const maxMemoryMiB = Number(maxMemoryRaw);
const maxCpuPercent = Number(maxCpuRaw);

function parseMemoryMiB(raw) {
  const value =
    String(raw || "")
      .split("/")[0]
      ?.trim() || "";
  const match = /^([0-9.]+)\s*([KMGT]?i?B)$/iu.exec(value);
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
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
  return 0;
}

const lines = fs.existsSync(statsFile)
  ? fs.readFileSync(statsFile, "utf8").split(/\r?\n/u).filter(Boolean)
  : [];
let maxObservedMemoryMiB = 0;
let maxObservedCpuPercent = 0;

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  maxObservedMemoryMiB = Math.max(maxObservedMemoryMiB, parseMemoryMiB(parsed.MemUsage));
  maxObservedCpuPercent = Math.max(
    maxObservedCpuPercent,
    Number(String(parsed.CPUPerc || "0").replace(/%$/u, "")) || 0,
  );
}

console.log(
  `${label} resource peak: memory=${maxObservedMemoryMiB.toFixed(1)}MiB cpu=${maxObservedCpuPercent.toFixed(1)}% samples=${lines.length}`,
);
if (lines.length === 0) {
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
