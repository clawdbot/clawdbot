import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "browser-plugin-profiles-packaged";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/browser-plugin-profiles-packaged.ts";
const SCRIPT_PATH = "scripts/e2e/browser-plugin-profiles-docker.sh";
const SUCCESS_MARKER = "BROWSER_PLUGIN_PROFILES_PACKAGED_OK";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type DockerOutcome = {
  code: number | null;
  error?: Error;
  markerSeen: boolean;
  signal: NodeJS.Signals | null;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseBrowserPluginProfilesOptions(args: string[]): ProducerOptions {
  if (args.length !== 2 || args[0] !== "--artifact-base" || !args[1]) {
    throw new Error("usage: --artifact-base <output-directory>");
  }
  return { artifactBase: path.resolve(args[1]), repoRoot: process.cwd() };
}

export function classifyBrowserPluginProfilesOutcome(outcome: DockerOutcome): {
  details?: string;
  status: "pass" | "fail";
} {
  if (outcome.error) {
    return { details: formatError(outcome.error), status: "fail" };
  }
  if (outcome.signal) {
    return { details: `Docker producer terminated by signal ${outcome.signal}`, status: "fail" };
  }
  if (outcome.code !== 0) {
    return { details: `Docker producer exited with code ${String(outcome.code)}`, status: "fail" };
  }
  if (!outcome.markerSeen) {
    return { details: `Docker producer omitted ${SUCCESS_MARKER}`, status: "fail" };
  }
  return { status: "pass" };
}

async function runDockerProducer(appendLog: (chunk: unknown) => void): Promise<DockerOutcome> {
  return await new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error: Error | undefined;
    let markerSeen = false;
    let carry = "";
    const append = (chunk: Buffer) => {
      const text = String(chunk);
      process.stdout.write(chunk);
      appendLog(chunk);
      const scan = `${carry}${text}`;
      markerSeen ||= scan.includes(SUCCESS_MARKER);
      carry = scan.slice(-SUCCESS_MARKER.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      appendLog(chunk);
      const scan = `${carry}${String(chunk)}`;
      markerSeen ||= scan.includes(SUCCESS_MARKER);
      carry = scan.slice(-SUCCESS_MARKER.length);
    });
    child.on("error", (value) => {
      error = value;
    });
    child.on("close", (code, signal) => resolve({ code, error, markerSeen, signal }));
  });
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const target = {
    codeRefs: [SOURCE_PATH, SCRIPT_PATH, "extensions/browser/src/gateway/browser-request.ts"],
    docsRefs: ["docs/tools/browser.md", "docs/help/testing.md"],
    id: SCENARIO_ID,
    sourcePath: SOURCE_PATH,
    title: "Packaged browser plugin profiles",
  };
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "browser-plugin-profiles-packaged.log",
    packageSource: { kind: "package-installed-docker" },
    primaryModel: "docker/packaged-browser",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target,
  });
  const startedAt = Date.now();
  const outcome = await runDockerProducer((chunk) => writer.appendLog(chunk));
  const result = classifyBrowserPluginProfilesOutcome(outcome);
  return await writer.write({
    details: result.details,
    durationMs: Math.max(1, Date.now() - startedAt),
    status: result.status,
  });
}

async function main(args: string[]) {
  const evidence = await runProducer(parseBrowserPluginProfilesOptions(args));
  const status = evidence.entries[0]?.result.status;
  console.log(`Packaged browser plugin profiles evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Packaged browser plugin profiles status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(formatError(error));
      process.exitCode = 1;
    });
}
