// Hosted media provider live runner and QA Lab evidence producer.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { spawnPnpmRunner as _spawnPnpmRunner } from "../../../../scripts/pnpm-runner.mjs";
import {
  createQaScriptBlockedStatusTracker,
  createQaScriptEvidenceWriter,
  type QaScriptEvidenceStatus,
} from "../runtime/script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/media/hosted-media-provider-live.ts";
const DEFAULT_PROVIDERS_ENV = "OPENCLAW_QA_HOSTED_MEDIA_PROVIDERS";

export type MediaSuiteId = "image" | "music" | "video";
type EvidenceSuiteId = "image" | "video";

export type MediaSuiteConfig = {
  id: MediaSuiteId;
  testFile: string;
  providerEnvVar: string;
  providers: string[];
  defaultProviders?: string[];
};

export const MEDIA_SUITES: Record<MediaSuiteId, MediaSuiteConfig> = {
  image: {
    id: "image",
    testFile: "test/image-generation.runtime.live.test.ts",
    providerEnvVar: "OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS",
    providers: ["deepinfra", "fal", "google", "minimax", "openai", "openrouter", "vydra", "xai"],
  },
  music: {
    id: "music",
    testFile: "extensions/music-generation-providers.live.test.ts",
    providerEnvVar: "OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS",
    providers: ["fal", "google", "minimax", "openrouter"],
  },
  video: {
    id: "video",
    testFile: "extensions/video-generation-providers.live.test.ts",
    providerEnvVar: "OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS",
    providers: [
      "alibaba",
      "byteplus",
      "deepinfra",
      "fal",
      "google",
      "minimax",
      "openai",
      "openrouter",
      "qwen",
      "runway",
      "together",
      "vydra",
      "xai",
    ],
    defaultProviders: [
      "alibaba",
      "byteplus",
      "deepinfra",
      "google",
      "minimax",
      "openai",
      "openrouter",
      "qwen",
      "runway",
      "together",
      "vydra",
      "xai",
    ],
  },
};

const DEFAULT_SUITES: MediaSuiteId[] = ["image", "music", "video"];

export type CliOptions = {
  allowEmpty: boolean;
  globalProviders: Set<string> | null;
  help: boolean;
  passthroughArgs: string[];
  quietArgs: string[];
  requireAuth: boolean;
  suiteProviders: Partial<Record<MediaSuiteId, Set<string>>>;
  suites: MediaSuiteId[];
};

export type SuiteRunPlan = {
  suite: MediaSuiteConfig;
  providers: string[];
  skippedReason?: string;
};

export type BuildRunPlanDeps = {
  collectProviderApiKeysImpl?: (provider: string) => Promise<unknown[]> | unknown[];
  getProviderEnvVarsImpl?: (provider: string) => Promise<string[]> | string[];
  loadShellEnvFallbackImpl?: (params: {
    enabled: true;
    env: NodeJS.ProcessEnv;
    expectedKeys: string[];
    logger: { warn: (message: string) => void };
  }) => Promise<void> | void;
};

export type RunCliDeps = {
  buildRunPlanImpl?: (options: CliOptions) => Promise<SuiteRunPlan[]> | SuiteRunPlan[];
  runSuiteImpl?: typeof runSuite;
};

type HostedMediaOptions = {
  artifactBase: string;
  providersEnv: string;
  repoRoot: string;
  suiteId: EvidenceSuiteId;
};

type HostedMediaSuiteDefinition = {
  codeRefs: string[];
  docsRefs: string[];
  scenarioId: string;
  title: string;
  videoFullModes?: boolean;
};

type HostedMediaProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

const EVIDENCE_SUITES: Record<EvidenceSuiteId, HostedMediaSuiteDefinition> = {
  image: {
    scenarioId: "hosted-image-generation-providers-live",
    title: "Hosted image generation providers live",
    docsRefs: [
      "docs/help/testing.md",
      "docs/tools/image-generation.md",
      "docs/tools/media-overview.md",
    ],
    codeRefs: [
      SOURCE_PATH,
      "test/image-generation.runtime.live.test.ts",
      "src/image-generation/live-test-helpers.ts",
    ],
  },
  video: {
    scenarioId: "hosted-video-generation-providers-live",
    title: "Hosted video generation providers live",
    docsRefs: [
      "docs/help/testing.md",
      "docs/tools/video-generation.md",
      "docs/tools/media-overview.md",
    ],
    codeRefs: [
      SOURCE_PATH,
      "extensions/video-generation-providers.live.test.ts",
      "src/video-generation/runtime.ts",
      "src/agents/tools/video-generate-tool.ts",
    ],
    videoFullModes: true,
  },
};

function formatProviderList(providers: Iterable<string>): string {
  return [...providers].toSorted().join(", ");
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function spawnLivePnpm(params: { pnpmArgs: string[]; env: NodeJS.ProcessEnv }) {
  return _spawnPnpmRunner({
    pnpmArgs: params.pnpmArgs,
    stdio: "inherit",
    env: params.env,
  });
}

async function collectProviderApiKeysForLiveMedia(provider: string): Promise<unknown[]> {
  const { collectProviderApiKeys } = await import("../../../../src/agents/live-auth-keys.js");
  return collectProviderApiKeys(provider);
}

async function getProviderEnvVarsForLiveMedia(provider: string): Promise<string[]> {
  const { getProviderEnvVars } = await import("../../../../src/secrets/provider-env-vars.js");
  return getProviderEnvVars(provider);
}

async function loadShellEnvFallbackForLiveMedia(params: {
  enabled: true;
  env: NodeJS.ProcessEnv;
  expectedKeys: string[];
  logger: { warn: (message: string) => void };
}): Promise<void> {
  const { loadShellEnvFallback } = await import("../../../../src/infra/shell-env.js");
  loadShellEnvFallback(params);
}

function parseCsv(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const values = trimmed
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? new Set(values) : null;
}

function parseSuiteToken(raw: string): MediaSuiteId | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "image" || normalized === "music" || normalized === "video") {
    return normalized;
  }
  return null;
}

function parseEvidenceSuiteToken(raw: string): EvidenceSuiteId {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "image" || normalized === "video") {
    return normalized;
  }
  throw new Error(`unsupported hosted media evidence suite: ${raw}`);
}

function readOptionValue(argv: readonly string[], index: number, arg: string) {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("-")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const separatorPassthroughArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const suites = new Set<MediaSuiteId>();
  const suiteProviders: Partial<Record<MediaSuiteId, Set<string>>> = {};
  const passthroughArgs: string[] = [];
  const quietArgs: string[] = [];
  let allowEmpty = false;
  let globalProviders: Set<string> | null = null;
  let help = false;
  let requireAuth = true;

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index] ?? "";
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (
      arg === "--quiet" ||
      arg === "--quiet-live" ||
      arg === "--no-quiet" ||
      arg === "--no-quiet-live"
    ) {
      quietArgs.push(arg);
      continue;
    }
    if (arg === "--providers") {
      globalProviders = parseCsv(readOptionValue(optionArgs, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--image-providers" || arg === "--music-providers" || arg === "--video-providers") {
      const suite = parseSuiteToken(arg.slice(2, arg.indexOf("-providers")));
      if (!suite) {
        throw new Error(`Unknown suite flag: ${arg}`);
      }
      suiteProviders[suite] =
        parseCsv(readOptionValue(optionArgs, index, arg)) ?? new Set<string>();
      index += 1;
      continue;
    }
    if (arg === "--with-auth" || arg === "--require-auth") {
      requireAuth = true;
      continue;
    }
    if (arg === "--allow-empty") {
      allowEmpty = true;
      continue;
    }
    if (arg === "--all-providers" || arg === "--no-auth-filter") {
      requireAuth = false;
      continue;
    }
    if (arg.startsWith("--")) {
      passthroughArgs.push(arg);
      const next = optionArgs[index + 1];
      if (next && !next.startsWith("--")) {
        passthroughArgs.push(next);
        index += 1;
      }
      continue;
    }
    const suite = parseSuiteToken(arg);
    if (suite) {
      suites.add(suite);
      continue;
    }
    if (arg === "all") {
      suites.add("image");
      suites.add("music");
      suites.add("video");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const options = {
    allowEmpty,
    globalProviders,
    help,
    passthroughArgs: [...passthroughArgs, ...separatorPassthroughArgs],
    quietArgs,
    requireAuth,
    suiteProviders,
    suites: (suites.size ? [...suites] : DEFAULT_SUITES).toSorted(),
  };
  validateProviderFilters(options);
  return options;
}

function validateProviderFilters(options: CliOptions): void {
  const selectedSuites = new Set(options.suites);
  const unselectedSuiteFilters = Object.keys(options.suiteProviders).filter(
    (suiteId) => !selectedSuites.has(suiteId as MediaSuiteId),
  );
  if (unselectedSuiteFilters.length > 0) {
    throw new Error(
      `Provider filter(s) target unselected media suite(s): ${unselectedSuiteFilters.toSorted().join(", ")}`,
    );
  }

  if (options.globalProviders) {
    const selectedProviders = new Set(
      options.suites.flatMap((suiteId) => MEDIA_SUITES[suiteId].providers),
    );
    const unknown = [...options.globalProviders].filter(
      (provider) => !selectedProviders.has(provider),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Unknown provider(s) for selected media suite(s): ${formatProviderList(unknown)}`,
      );
    }
  }

  for (const [suiteId, providers] of Object.entries(options.suiteProviders) as [
    MediaSuiteId,
    Set<string>,
  ][]) {
    const suite = MEDIA_SUITES[suiteId];
    const supported = new Set(suite.providers);
    const unknown = [...providers].filter((provider) => !supported.has(provider));
    if (unknown.length > 0) {
      throw new Error(`Unknown ${suiteId} provider(s): ${formatProviderList(unknown)}`);
    }
  }
}

function hasExplicitProviderSelection(options: CliOptions): boolean {
  return options.globalProviders !== null || Object.keys(options.suiteProviders).length > 0;
}

function hasExplicitProviderSelectionForSuite(options: CliOptions, suiteId: MediaSuiteId): boolean {
  if (Object.hasOwn(options.suiteProviders, suiteId)) {
    return true;
  }
  if (!options.globalProviders) {
    return false;
  }
  return MEDIA_SUITES[suiteId].providers.some((provider) => options.globalProviders?.has(provider));
}

export function findSkippedExplicitProviderSelections(
  options: CliOptions,
  plan: SuiteRunPlan[],
): SuiteRunPlan[] {
  return plan.filter(
    (entry) =>
      entry.providers.length === 0 && hasExplicitProviderSelectionForSuite(options, entry.suite.id),
  );
}

async function selectProviders(params: {
  collectProviderApiKeysImpl?: BuildRunPlanDeps["collectProviderApiKeysImpl"];
  globalProviders: Set<string> | null;
  requireAuth: boolean;
  suite: MediaSuiteConfig;
  suiteProviders: Set<string> | undefined;
}): Promise<string[]> {
  const explicit = params.suiteProviders ?? params.globalProviders;
  const candidates = explicit
    ? params.suite.providers
    : (params.suite.defaultProviders ?? params.suite.providers);
  let providers = candidates.filter((provider) => (explicit ? explicit.has(provider) : true));
  if (!params.requireAuth) {
    return providers;
  }
  const providerAuth = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      hasAuth:
        (await (params.collectProviderApiKeysImpl ?? collectProviderApiKeysForLiveMedia)(provider))
          .length > 0,
    })),
  );
  return providerAuth.filter((entry) => entry.hasAuth).map((entry) => entry.provider);
}

export async function buildRunPlan(
  options: CliOptions,
  deps: BuildRunPlanDeps = {},
): Promise<SuiteRunPlan[]> {
  const getProviderEnvVarsImpl = deps.getProviderEnvVarsImpl ?? getProviderEnvVarsForLiveMedia;
  const expectedKeys = [
    ...new Set(
      (
        await Promise.all(
          options.suites.flatMap((suiteId) =>
            MEDIA_SUITES[suiteId].providers.map(
              async (provider) => await getProviderEnvVarsImpl(provider),
            ),
          ),
        )
      ).flat(),
    ),
  ];
  if (expectedKeys.length) {
    await (deps.loadShellEnvFallbackImpl ?? loadShellEnvFallbackForLiveMedia)({
      enabled: true,
      env: process.env,
      expectedKeys,
      logger: { warn: (message: string) => console.warn(message) },
    });
  }

  return await Promise.all(
    options.suites.map(async (suiteId) => {
      const suite = MEDIA_SUITES[suiteId];
      const providers = await selectProviders({
        collectProviderApiKeysImpl: deps.collectProviderApiKeysImpl,
        globalProviders: options.globalProviders,
        requireAuth: options.requireAuth,
        suite,
        suiteProviders: options.suiteProviders[suiteId],
      });
      return {
        suite,
        providers,
        ...(providers.length === 0
          ? {
              skippedReason: options.requireAuth
                ? "no providers with usable auth"
                : "no providers selected",
            }
          : {}),
      };
    }),
  );
}

export function formatHelp(): string {
  return `Media live harness

Usage:
  pnpm test:live:media
  pnpm test:live:media image
  pnpm test:live:media image video --providers openai,google,minimax
  pnpm test:live:media video --video-providers openai,runway --all-providers

QA evidence mode:
  node --import tsx ${SOURCE_PATH} --qa-evidence --suite image --artifact-base <dir>
  node --import tsx ${SOURCE_PATH} --qa-evidence --suite video --artifact-base <dir>

Defaults:
  - runs image + music + video
  - auto-loads missing provider env vars from ~/.profile
  - narrows each suite to providers that currently have usable auth
  - skips the slow fal video smoke by default; pass --video-providers fal to run it
  - forwards extra args to scripts/test-live.mjs

Flags:
  --providers <csv>         global provider filter
  --image-providers <csv>   image-suite provider filter
  --music-providers <csv>   music-suite provider filter
  --video-providers <csv>   video-suite provider filter
  --all-providers           do not auto-filter by available auth
  --allow-empty             exit 0 when auth filtering leaves no runnable providers
  --quiet | --no-quiet      passed through to test:live
`;
}

function printHelp(): void {
  console.log(formatHelp());
}

export async function runSuite(params: {
  passthroughArgs: string[];
  plan: SuiteRunPlan;
  quietArgs: string[];
}): Promise<number> {
  const { plan } = params;
  if (!plan.providers.length) {
    console.log(
      `[live:media] skip ${plan.suite.id}: ${plan.skippedReason ?? "no providers selected"}`,
    );
    return 0;
  }

  const env = {
    ...process.env,
    [plan.suite.providerEnvVar]: plan.providers.join(","),
  };
  const args = [
    "test:live",
    ...params.quietArgs,
    "--",
    plan.suite.testFile,
    ...params.passthroughArgs,
  ];
  console.log(
    `[live:media] run ${plan.suite.id}: ${plan.suite.testFile} providers=${plan.providers.join(",")}`,
  );

  const child = spawnLivePnpm({ pnpmArgs: args, env });

  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        reject(new Error(`${plan.suite.id} exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const plan = await (deps.buildRunPlanImpl ?? buildRunPlan)(options);
  const runnable = plan.filter((entry) => entry.providers.length > 0);
  const skipped = plan.filter((entry) => entry.providers.length === 0);

  for (const entry of skipped) {
    console.log(
      `[live:media] skip ${entry.suite.id}: ${entry.skippedReason ?? "no providers selected"}`,
    );
  }
  const skippedExplicit = findSkippedExplicitProviderSelections(options, plan);
  if (skippedExplicit.length > 0) {
    console.error(
      `[live:media] no runnable providers matched explicit provider selection for: ${skippedExplicit.map((entry) => entry.suite.id).join(", ")}`,
    );
    return 1;
  }
  if (runnable.length === 0) {
    console.log("[live:media] nothing to run");
    if (options.allowEmpty) {
      return 0;
    }
    console.error(
      hasExplicitProviderSelection(options)
        ? "[live:media] no runnable providers matched the explicit provider selection"
        : "[live:media] no runnable providers matched available auth; pass --allow-empty to accept an empty live-media run",
    );
    return 1;
  }

  for (const entry of runnable) {
    const exitCode = await (deps.runSuiteImpl ?? runSuite)({
      passthroughArgs: options.passthroughArgs,
      plan: entry,
      quietArgs: options.quietArgs,
    });
    if (exitCode !== 0) {
      return exitCode;
    }
  }
  return 0;
}

export function parseHostedMediaOptions(argv: readonly string[]): HostedMediaOptions {
  let artifactBase = "";
  let providersEnv = DEFAULT_PROVIDERS_ENV;
  let repoRoot = process.cwd();
  let suiteId: EvidenceSuiteId | undefined;
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--qa-evidence") {
      continue;
    }
    if (arg === "--artifact-base") {
      recordOnce(arg);
      artifactBase = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      recordOnce(arg);
      repoRoot = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--providers-env") {
      recordOnce(arg);
      providersEnv = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      recordOnce(arg);
      suiteId = parseEvidenceSuiteToken(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`unsupported hosted media evidence arg: ${arg}`);
  }

  if (!artifactBase.trim()) {
    throw new Error("--artifact-base is required");
  }
  if (!suiteId) {
    throw new Error("--suite is required");
  }
  if (!providersEnv.trim()) {
    throw new Error("--providers-env requires a non-empty env var name");
  }

  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    providersEnv,
    repoRoot: path.resolve(repoRoot),
    suiteId,
  };
}

function suiteProviderFilter(options: HostedMediaOptions, env: NodeJS.ProcessEnv) {
  const suiteEnv = `OPENCLAW_QA_HOSTED_${options.suiteId.toUpperCase()}_PROVIDERS`;
  return env[suiteEnv]?.trim() || env[options.providersEnv]?.trim() || "";
}

export function buildHostedMediaCommand(params: {
  env?: NodeJS.ProcessEnv;
  options: HostedMediaOptions;
}) {
  const definition = EVIDENCE_SUITES[params.options.suiteId];
  const env = { ...(params.env ?? process.env) };
  const args = ["--import", "tsx", SOURCE_PATH, params.options.suiteId];
  const providerFilter = suiteProviderFilter(params.options, env);
  if (providerFilter) {
    args.push(`--${params.options.suiteId}-providers`, providerFilter);
  }
  if (definition.videoFullModes) {
    env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES = "1";
  }
  return {
    args,
    command: process.execPath,
    env,
  };
}

const HOSTED_MEDIA_BLOCKED_PATTERNS = [
  /no runnable providers matched available auth/i,
  /no runnable providers matched the explicit provider selection/i,
  /no runnable providers matched explicit provider selection/i,
  /no providers with usable auth/i,
];

export function classifyHostedMediaFailureStatus(message: string): QaScriptEvidenceStatus {
  const tracker = createQaScriptBlockedStatusTracker(HOSTED_MEDIA_BLOCKED_PATTERNS);
  tracker.append(message);
  return tracker.status();
}

function formatCommand(command: string, args: readonly string[]) {
  return [command, ...args].map((arg) => JSON.stringify(arg)).join(" ");
}

function createHostedMediaEvidenceWriter(options: HostedMediaOptions) {
  const definition = EVIDENCE_SUITES[options.suiteId];
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "hosted-media-live.log",
    primaryModel: "live-media/hosted-media-provider",
    providerMode: "live-frontier",
    repoRoot: options.repoRoot,
    target: {
      id: definition.scenarioId,
      title: definition.title,
      sourcePath: SOURCE_PATH,
      docsRefs: definition.docsRefs,
      codeRefs: definition.codeRefs,
    },
  });
}

async function runHostedMediaProof(
  options: HostedMediaOptions,
  writer: ReturnType<typeof createHostedMediaEvidenceWriter>,
): Promise<HostedMediaProofResult> {
  const startedAt = Date.now();
  const command = buildHostedMediaCommand({ options });

  writer.appendLog(`$ ${formatCommand(command.command, command.args)}\n`);
  writer.appendLog(
    `suite: ${options.suiteId}\nprovidersEnv: ${options.providersEnv}\nvideoFullModes: ${String(EVIDENCE_SUITES[options.suiteId].videoFullModes === true)}\n`,
  );

  return await new Promise<HostedMediaProofResult>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: options.repoRoot,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const statusTracker = createQaScriptBlockedStatusTracker(HOSTED_MEDIA_BLOCKED_PATTERNS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      writer.appendLog(chunk);
      statusTracker.append(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      writer.appendLog(chunk);
      statusTracker.append(chunk);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const durationMs = Math.max(1, Date.now() - startedAt);
      if (status === 0 && !signal) {
        resolve({
          details: `${options.suiteId} hosted media live suite passed`,
          durationMs,
          status: "pass",
        });
        return;
      }
      const details = signal
        ? `${options.suiteId} hosted media live suite terminated by ${signal}`
        : `${options.suiteId} hosted media live suite exited with ${status ?? 1}`;
      resolve({
        details,
        durationMs,
        status: statusTracker.status(),
      });
    });
  });
}

export function buildHostedMediaEvidence(params: {
  options: HostedMediaOptions;
  result: HostedMediaProofResult;
}): QaEvidenceSummaryJson {
  return createHostedMediaEvidenceWriter(params.options).build(params.result);
}

async function runHostedMediaProviderLiveProducer(
  options: HostedMediaOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createHostedMediaEvidenceWriter(options);
  const result = await runHostedMediaProof(options, writer);
  return await writer.write(result);
}

async function main(argv: string[]) {
  if (argv.includes("--qa-evidence")) {
    const evidence = await runHostedMediaProviderLiveProducer(parseHostedMediaOptions(argv));
    console.log(`Hosted media provider live evidence: ${QA_EVIDENCE_FILENAME}`);
    console.log(`Hosted media provider live status: ${evidence.entries[0]?.result.status}`);
    return evidence.entries[0]?.result.status === "fail" ? 1 : 0;
  }
  return await runCli(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exit(1);
    });
}
