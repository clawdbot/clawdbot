import fs from "node:fs";

const logPath = process.env.OPENCLAW_CONFIG_RELOAD_LOG_PATH ?? "/tmp/config-reload-e2e.log";
const deadlineMs = Date.now() + Number(process.env.OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS ?? 30_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLog() {
  return fs.readFileSync(logPath, "utf8");
}

function inspectLog(log) {
  const lines = log.split("\n");
  const reloadLines = lines.filter((line) =>
    line.includes("config change detected; evaluating reload"),
  );
  const restartLines = lines.filter((line) =>
    line.includes("config change requires gateway restart"),
  );
  return { lines, reloadLines, restartLines };
}

let log = "";
let result = { lines: [], reloadLines: [], restartLines: [] };

while (Date.now() < deadlineMs) {
  log = readLog();
  result = inspectLog(log);
  if (result.restartLines.length > 0 || result.reloadLines.length > 0) {
    break;
  }
  await sleep(500);
}

if (result.restartLines.length > 0) {
  console.error(result.lines.slice(-160).join("\n"));
  throw new Error("unexpected restart-required reload line found");
}
for (const line of result.reloadLines) {
  for (const needle of ["gateway.auth.token", "plugins.entries.firecrawl.config.webFetch"]) {
    if (line.includes(needle)) {
      console.error(result.lines.slice(-160).join("\n"));
      throw new Error(`runtime-only path appeared in reload diff: ${needle}`);
    }
  }
}
if (result.reloadLines.length === 0) {
  console.error(result.lines.slice(-160).join("\n"));
  throw new Error("expected config reload detection log after metadata write");
}
