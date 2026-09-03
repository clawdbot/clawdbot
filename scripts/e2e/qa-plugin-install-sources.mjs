import { spawn } from "node:child_process";
import { createQaScriptEvidenceWriter } from "../../test/e2e/qa-lab/runtime/script-evidence.js";

const args = process.argv.slice(2);
const artifactBaseIndex = args.indexOf("--artifact-base");
const artifactBase = args[artifactBaseIndex + 1];
if (artifactBaseIndex === -1 || !artifactBase || artifactBase.startsWith("-")) {
  throw new Error("--artifact-base is required");
}

const writer = createQaScriptEvidenceWriter({
  artifactBase,
  logFileName: "cli-plugin-install-sources.log",
  primaryModel: "openai/gpt-5.6-luna",
  providerMode: "mock-openai",
  repoRoot: process.cwd(),
  target: {
    id: "cli-plugin-install-sources",
    title: "CLI plugin install sources",
    sourcePath: "scripts/e2e/qa-plugin-install-sources.mjs",
    docsRefs: ["docs/cli/plugins.md"],
    codeRefs: [
      "src/cli/plugins-cli.ts",
      "src/plugins/install.ts",
      "src/plugins/install-source-info.ts",
      "scripts/e2e/lib/plugins/sweep.sh",
      "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh",
    ],
  },
});
const requiredMarkers = [
  "Testing tgz install flow...",
  "Testing install from local folder (plugins.load.paths)...",
  "Testing install from npm spec (file:)...",
  "Testing install and update from npm registry...",
  "Testing install from git repo and plugin CLI execution...",
  "Testing marketplace install and update flows...",
  "Testing ClawHub plugin install and uninstall...",
];
const seenMarkers = new Set();
let markerCarry = "";
let receivedSignal = null;
let bundledSelectionProven = false;

const collectMarkers = (chunk) => {
  const text = `${markerCarry}${chunk}`;
  for (const marker of requiredMarkers) {
    if (text.includes(marker)) {
      seenMarkers.add(marker);
    }
  }
  if (/bundled plugin install\/uninstall sweep passed \(([1-9]\d*) plugin\(s\)\)/u.test(text)) {
    bundledSelectionProven = true;
  }
  markerCarry = text.slice(-256);
};

const runScript = (script, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
    });
    const onChunk = (stream, chunk) => {
      writer.appendLog(chunk);
      collectMarkers(chunk);
      stream.write(chunk);
    };
    child.stdout.on("data", (chunk) => onChunk(process.stdout, chunk));
    child.stderr.on("data", (chunk) => onChunk(process.stderr, chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      receivedSignal ??= signal;
      resolve(code ?? 1);
    });
  });

const startedAt = Date.now();
let status = await runScript("scripts/e2e/plugins-docker.sh", {
  OPENCLAW_PLUGINS_E2E_CLAWHUB: "1",
  OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB: "0",
});
if (status === 0) {
  status = await runScript("scripts/e2e/bundled-plugin-install-uninstall-docker.sh");
}
const missingMarkers = requiredMarkers.filter((marker) => !seenMarkers.has(marker));
if (!bundledSelectionProven) {
  missingMarkers.push("bundled plugin install/uninstall sweep passed (>0 plugin(s))");
}
if (missingMarkers.length > 0) {
  status = 1;
}
await writer.write({
  status: status === 0 ? "pass" : "fail",
  durationMs: Date.now() - startedAt,
  ...(missingMarkers.length > 0
    ? { details: `missing executable assertion marker(s): ${missingMarkers.join(", ")}` }
    : {}),
});

if (receivedSignal) {
  process.kill(process.pid, receivedSignal);
}
process.exit(status);
