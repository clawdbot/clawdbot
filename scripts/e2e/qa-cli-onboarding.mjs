import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildScriptEvidenceSummary, QA_EVIDENCE_FILENAME } from "../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "../../test/e2e/qa-lab/runtime/script-evidence.js";

const args = process.argv.slice(2);
const artifactBaseIndex = args.indexOf("--artifact-base");
const artifactBase = args[artifactBaseIndex + 1];
if (artifactBaseIndex === -1 || !artifactBase || artifactBase.startsWith("-")) {
  throw new Error("--artifact-base is required");
}

const boundaries = [
  {
    id: "cli-gateway-auth-storage",
    title: "CLI Gateway auth storage",
    markers: [
      "QA_ASSERT cli.gateway-auth-storage.token-ref pass",
      "QA_ASSERT cli.gateway-auth-storage.password pass",
    ],
  },
  {
    id: "cli-guided-onboarding",
    title: "CLI guided onboarding",
    marker: "QA_ASSERT cli.guided-onboarding pass",
  },
  {
    id: "cli-remote-onboarding",
    title: "CLI remote onboarding",
    marker: "QA_ASSERT cli.remote-onboarding pass",
  },
  {
    id: "cli-targeted-reconfiguration",
    title: "CLI targeted reconfiguration",
    markers: [
      "QA_ASSERT cli.targeted-reconfiguration.reset pass",
      "QA_ASSERT cli.targeted-reconfiguration.skills pass",
    ],
  },
];
const writer = createQaScriptEvidenceWriter({
  artifactBase,
  logFileName: "cli-onboarding.log",
  primaryModel: "openai/gpt-5.6-luna",
  providerMode: "mock-openai",
  repoRoot: process.cwd(),
  target: {
    id: "cli-onboarding",
    title: "CLI onboarding boundaries",
    sourcePath: "scripts/e2e/qa-cli-onboarding.mjs",
  },
});

const seenMarkers = new Set();
let markerCarry = "";
const collectMarkers = (chunk) => {
  const text = `${markerCarry}${chunk}`;
  for (const boundary of boundaries) {
    for (const marker of boundary.markers ?? [boundary.marker]) {
      if (text.includes(marker)) {
        seenMarkers.add(marker);
      }
    }
  }
  markerCarry = text.slice(-256);
};

const startedAt = Date.now();
const child = spawn("bash", ["scripts/e2e/onboard-docker.sh"], {
  env: {
    ...process.env,
    OPENCLAW_ONBOARD_E2E_CASES:
      "guided-skip-ui,local-auth-refs,local-password,remote-non-interactive,reset,skills",
  },
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  writer.appendLog(chunk);
  collectMarkers(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  writer.appendLog(chunk);
  collectMarkers(chunk);
  process.stderr.write(chunk);
});

const { code, signal } = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (closeCode, closeSignal) =>
    resolve({ code: closeCode, signal: closeSignal }),
  );
});
const durationMs = Date.now() - startedAt;
const results = boundaries.map((boundary) => {
  const markers = boundary.markers ?? [boundary.marker];
  const missingMarkers = markers.filter((marker) => !seenMarkers.has(marker));
  return {
    id: boundary.id,
    status: missingMarkers.length === 0 ? "pass" : "fail",
    durationMs,
    ...(missingMarkers.length > 0
      ? { failureMessage: `missing executable assertion marker(s): ${missingMarkers.join(", ")}` }
      : {}),
  };
});
const logArtifact = await writer.writeLog();
const evidence = buildScriptEvidenceSummary({
  artifactPaths: [logArtifact],
  env: process.env,
  generatedAt: new Date().toISOString(),
  primaryModel: "openai/gpt-5.6-luna",
  providerMode: "mock-openai",
  repoRoot: process.cwd(),
  runner: "script",
  targets: boundaries.map((boundary) => ({
    id: boundary.id,
    title: boundary.title,
    sourcePath: "scripts/e2e/qa-cli-onboarding.mjs",
  })),
  results,
});
await fs.mkdir(artifactBase, { recursive: true });
await fs.writeFile(
  path.join(artifactBase, QA_EVIDENCE_FILENAME),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(artifactBase, "latest-run.json"),
  `${JSON.stringify({ qaEvidence: QA_EVIDENCE_FILENAME }, null, 2)}\n`,
  "utf8",
);

if (signal) {
  process.kill(process.pid, signal);
}
const missingBoundary = results.some((result) => result.status !== "pass");
process.exit(code === 0 && missingBoundary ? 1 : (code ?? 1));
