// Realtime Talk live producer exposes the canonical smoke through QA Lab evidence.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import {
  createQaScriptBlockedStatusTracker,
  createQaScriptEvidenceWriter,
  type QaScriptEvidenceStatus,
} from "../runtime/script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/media/realtime-talk-live.ts";
const SMOKE_PATH = "scripts/dev/realtime-talk-live-smoke.ts";
const SCENARIO_ID = "openai-realtime-talk-live";
const OPENAI_AUDIO_CYCLES = 1;
const DEFAULT_OPENAI_MODEL = "gpt-realtime-2.1";
const DEFAULT_OPENAI_VOICE = "alloy";
const AUDIO_FORMAT = "pcm16le";
const AUDIO_SAMPLE_RATE_HZ = 24_000;
const AUDIO_CHANNELS = 1;
const RESULT_LINE_CARRY_CHARS = 2048;
const EXPECTED_LEGS = [
  "openai-backend-bridge",
  "openai-backend-audio-roundtrip",
  "openai-webrtc-browser",
] as const;

type ExpectedLeg = (typeof EXPECTED_LEGS)[number];
type LegStatus = "ok" | "failed";

type RealtimeTalkLiveOptions = {
  artifactBase: string;
  repoRoot: string;
};

type RealtimeTalkCommand = {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
};

type RealtimeTalkChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type RealtimeTalkChildRunner = (params: {
  command: RealtimeTalkCommand;
  cwd: string;
  onStderr: (chunk: unknown) => void;
  onStdout: (chunk: unknown) => void;
}) => Promise<RealtimeTalkChildResult>;

type RealtimeTalkProofResult = {
  details: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

type RealtimeTalkLiveDependencies = {
  runChild: RealtimeTalkChildRunner;
};

function readOptionValue(argv: readonly string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseRealtimeTalkLiveOptions(
  argv: readonly string[],
  repoRoot = process.cwd(),
): RealtimeTalkLiveOptions {
  let artifactBase = "";
  let resolvedRepoRoot = repoRoot;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-base" || arg === "--repo-root") {
      if (seen.has(arg)) {
        throw new Error(`${arg} was provided more than once`);
      }
      seen.add(arg);
      const value = readOptionValue(argv, index, arg);
      if (arg === "--artifact-base") {
        artifactBase = value;
      } else {
        resolvedRepoRoot = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unsupported realtime Talk live evidence arg: ${arg}`);
  }

  if (!artifactBase.trim()) {
    throw new Error("--artifact-base is required");
  }
  const absoluteRepoRoot = path.resolve(resolvedRepoRoot);
  return {
    artifactBase: path.resolve(absoluteRepoRoot, artifactBase),
    repoRoot: absoluteRepoRoot,
  };
}

export function buildRealtimeTalkLiveCommand(
  env: NodeJS.ProcessEnv = process.env,
): RealtimeTalkCommand {
  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      SMOKE_PATH,
      "--openai-only",
      "--openai-audio-cycles",
      String(OPENAI_AUDIO_CYCLES),
    ],
    env: { ...env },
  };
}

function isExpectedLeg(value: string): value is ExpectedLeg {
  return EXPECTED_LEGS.some((leg) => leg === value);
}

function isLegStatus(value: string): value is LegStatus {
  return value === "ok" || value === "failed";
}

export function createRealtimeTalkResultParser() {
  const statuses = new Map<ExpectedLeg, LegStatus[]>();
  let carry = "";

  const consumeLine = (line: string) => {
    const match =
      /^(openai-backend-bridge|openai-backend-audio-roundtrip|openai-webrtc-browser): (ok|failed)\b/u.exec(
        line,
      );
    const leg = match?.[1] ?? "";
    const status = match?.[2] ?? "";
    if (!isExpectedLeg(leg) || !isLegStatus(status)) {
      return;
    }
    const entries = statuses.get(leg) ?? [];
    entries.push(status);
    statuses.set(leg, entries);
  };

  return {
    append(chunk: unknown) {
      const text = `${carry}${String(chunk)}`;
      const lines = text.split(/\r?\n/u);
      carry = lines.pop()?.slice(-RESULT_LINE_CARRY_CHARS) ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    },
    finish() {
      if (carry) {
        consumeLine(carry);
        carry = "";
      }
      return new Map(statuses);
    },
  };
}

function summarizeLegStatuses(statuses: ReadonlyMap<ExpectedLeg, readonly LegStatus[]>) {
  return EXPECTED_LEGS.map((leg) => {
    const entries = statuses.get(leg) ?? [];
    if (entries.length !== 1) {
      return `${leg}=${entries.length === 0 ? "missing" : "duplicate"}`;
    }
    return `${leg}=${entries[0]}`;
  });
}

function statusDigest(statusSummary: readonly string[]) {
  return createHash("sha256").update(statusSummary.join("\n"), "utf8").digest("hex");
}

const HARNESS_BLOCKED_PATTERNS = [
  /executable doesn't exist/i,
  /playwright install/i,
  /cannot find (?:package|module) ['"]playwright/i,
  /cannot find (?:package|module) ['"]tsx/i,
];

function createRealtimeTalkEvidenceWriter(
  options: RealtimeTalkLiveOptions,
  env: NodeJS.ProcessEnv,
) {
  const model = env.OPENCLAW_REALTIME_OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    env,
    logFileName: "realtime-talk-live.log",
    primaryModel: `openai/${model}`,
    providerMode: "live-frontier",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "OpenAI realtime Talk live",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/nodes/talk.md", "docs/providers/openai/voice-and-speech.md"],
      codeRefs: [
        SOURCE_PATH,
        SMOKE_PATH,
        "extensions/openai/realtime-voice-provider.ts",
        "ui/src/pages/chat/realtime-talk-webrtc.ts",
      ],
    },
  });
}

const defaultDependencies: RealtimeTalkLiveDependencies = {
  runChild: async ({ command, cwd, onStderr, onStdout }) =>
    await new Promise<RealtimeTalkChildResult>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd,
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    }),
};

async function runRealtimeTalkLiveProof(params: {
  dependencies: RealtimeTalkLiveDependencies;
  env: NodeJS.ProcessEnv;
  options: RealtimeTalkLiveOptions;
  writer: ReturnType<typeof createRealtimeTalkEvidenceWriter>;
}): Promise<RealtimeTalkProofResult> {
  const startedAt = Date.now();
  const openAIKey = params.env.OPENAI_API_KEY?.trim();
  const model = params.env.OPENCLAW_REALTIME_OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const voice = params.env.OPENCLAW_REALTIME_OPENAI_VOICE?.trim() || DEFAULT_OPENAI_VOICE;

  params.writer.appendLog(
    [
      `scenario: ${SCENARIO_ID}`,
      `model: openai/${model}`,
      `voice: ${voice}`,
      `audioFormat: ${AUDIO_FORMAT}`,
      `audioSampleRateHz: ${AUDIO_SAMPLE_RATE_HZ}`,
      `audioChannels: ${AUDIO_CHANNELS}`,
      `audioCycles: ${OPENAI_AUDIO_CYCLES}`,
    ].join("\n") + "\n",
  );

  if (!openAIKey) {
    params.writer.appendLog("result: blocked; OPENAI_API_KEY is not set\n");
    return {
      details: "OpenAI realtime Talk live proof requires OPENAI_API_KEY",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "blocked",
    };
  }

  const command = buildRealtimeTalkLiveCommand(params.env);
  const parser = createRealtimeTalkResultParser();
  const blockedTracker = createQaScriptBlockedStatusTracker(HARNESS_BLOCKED_PATTERNS);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const appendOutput = (stream: "stdout" | "stderr", chunk: unknown) => {
    const bytes = Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk));
    if (stream === "stdout") {
      stdoutBytes += bytes;
      parser.append(chunk);
    } else {
      stderrBytes += bytes;
    }
    blockedTracker.append(chunk);
  };

  let childResult: RealtimeTalkChildResult;
  try {
    childResult = await params.dependencies.runChild({
      command,
      cwd: params.options.repoRoot,
      onStdout: (chunk) => appendOutput("stdout", chunk),
      onStderr: (chunk) => appendOutput("stderr", chunk),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blockedTracker.append(message);
    childResult = { exitCode: 1, signal: null };
    stderrBytes += Buffer.byteLength(message);
  }

  const statuses = parser.finish();
  const summary = summarizeLegStatuses(statuses);
  const digest = statusDigest(summary);
  const complete = EXPECTED_LEGS.every((leg) => statuses.get(leg)?.length === 1);
  const allPassed = EXPECTED_LEGS.every((leg) => statuses.get(leg)?.[0] === "ok");
  const observedFailure = EXPECTED_LEGS.some((leg) => statuses.get(leg)?.includes("failed"));
  const exitedCleanly = childResult.exitCode === 0 && childResult.signal === null;
  const status: QaScriptEvidenceStatus =
    exitedCleanly && complete && allPassed
      ? "pass"
      : !observedFailure && blockedTracker.status() === "blocked"
        ? "blocked"
        : "fail";
  const exit = childResult.signal
    ? `signal:${childResult.signal}`
    : `code:${childResult.exitCode ?? "null"}`;

  params.writer.appendLog(
    [
      `result: ${status}`,
      `exit: ${exit}`,
      `stdoutBytes: ${stdoutBytes}`,
      `stderrBytes: ${stderrBytes}`,
      `statusSha256: ${digest}`,
      ...summary,
    ].join("\n") + "\n",
  );

  return {
    details: [
      `OpenAI realtime Talk live proof ${status}`,
      `exit=${exit}`,
      `stdoutBytes=${stdoutBytes}`,
      `stderrBytes=${stderrBytes}`,
      `statusSha256=${digest}`,
      ...summary,
    ].join("; "),
    durationMs: Math.max(1, Date.now() - startedAt),
    status,
  };
}

export function buildRealtimeTalkLiveEvidence(params: {
  env?: NodeJS.ProcessEnv;
  options: RealtimeTalkLiveOptions;
  result: RealtimeTalkProofResult;
}): QaEvidenceSummaryJson {
  const env = params.env ?? process.env;
  return createRealtimeTalkEvidenceWriter(params.options, env).build(params.result);
}

export async function runRealtimeTalkLiveProducer(
  options: RealtimeTalkLiveOptions,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RealtimeTalkLiveDependencies = defaultDependencies,
): Promise<QaEvidenceSummaryJson> {
  const writer = createRealtimeTalkEvidenceWriter(options, env);
  const result = await runRealtimeTalkLiveProof({
    dependencies,
    env,
    options,
    writer,
  });
  return await writer.write(result);
}

async function main(argv: string[]) {
  const options = parseRealtimeTalkLiveOptions(argv);
  const evidence = await runRealtimeTalkLiveProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Realtime Talk live evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Realtime Talk live status: ${status}`);
  return status === "fail" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
