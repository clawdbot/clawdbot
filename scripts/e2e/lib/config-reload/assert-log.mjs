import fs from "node:fs";

const log = fs.readFileSync("/tmp/config-reload-e2e.log", "utf8");
const reloadLines = log
  .split("\n")
  .filter((line) => line.includes("config change detected; evaluating reload"));
const restartLines = log
  .split("\n")
  .filter((line) => line.includes("config change requires gateway restart"));

if (restartLines.length > 0) {
  console.error(log.split("\n").slice(-160).join("\n"));
  throw new Error("unexpected restart-required reload line found");
}
for (const line of reloadLines) {
  for (const needle of ["gateway.auth.token", "plugins.entries.firecrawl.config.webFetch"]) {
    if (line.includes(needle)) {
      console.error(log.split("\n").slice(-160).join("\n"));
      throw new Error(`runtime-only path appeared in reload diff: ${needle}`);
    }
  }
}
if (reloadLines.length === 0) {
  console.error(log.split("\n").slice(-160).join("\n"));
  throw new Error("expected config reload detection log after metadata write");
}
