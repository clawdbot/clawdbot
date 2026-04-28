#!/usr/bin/env -S node --import tsx

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { loadShellEnvFallback } from "../src/infra/shell-env.js";
import { getProviderEnvVars } from "../src/secrets/provider-env-vars.js";
type SpawnPnpmRunner = (params: {
  pnpmArgs: string[];
  stdio: "inherit";
  env: NodeJS.ProcessEnv;
}) => ChildProcess;

const require = createRequire(import.meta.url);
const { spawnPnpmRunner: _spawnPnpmRunner } = require("./pnpm-runner.mjs") as {
  spawnPnpmRunner: SpawnPnpmRunner;
};

export type MediaSuiteId = "image" | "music" | "video";

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
    providers: ["deepinfra", "fal", "google", "minimax", "openai", "vydra", "xai"],
  },
  music: {
    id: "music",
    testFile: "extensions/music-generation-providers.live.test.ts",
    providerEnvVar: "OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS",
    providers: ["google", "minimax"],
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
  suites: MediaSuiteId[];
  globalProviders: Set<string> | null;
  suiteProviders: Partial<Record<MediaSuiteId, Set<string>>>;
  requireAuth: boolean;
  quietArgs: string[];
  passthroughArgs: string[];
  help: boolean;
};

export type SuiteRunPlan = {
  suite: MediaSuiteConfig;
  providers: string[];
  skippedReason?: string;
};

function spawnLivePnpm(params: { pnpmArgs: string[]; env: NodeJS.ProcessEnv }): ChildProcess {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...params.pnpmArgs], {
      stdio: "inherit",
      env: params.env,
      shell: false,
    });
  }

  return spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", params.pnpmArgs, {
    stdio: "inherit",
    env: params.env,
    shell: false,
  });
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

export function parseArgs(argv: string[]): CliOptions {
  const suites = new Set<MediaSuiteId>();
  const suiteProviders: Partial<Record<MediaSuiteId, Set<string>>> = {};
  const passthroughArgs: string[] = [];
  const quietArgs: string[] = [];
  let globalProviders: Set<string> | null = null;
  let requireAuth = true;
  let help = false;

  const readValue = (index: number): string => {
    const value = argv[index + 1]?.trim();
    if (!value) {
      throw new Error(`Missing value for ${argv[index]}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg || arg === "--") {
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
      globalProviders = parseCsv(readValue(index));
      index += 1;
      continue;
    }
    if (arg === "--image-providers" || arg === "--music-providers" || arg === "--video-providers") {
      const suite = parseSuiteToken(arg.slice(2, arg.indexOf("-providers")));
      if (!suite) {
        throw new Error(`Unknown suite flag: ${arg}`);
      }
      suiteProviders[suite] = parseCsv(readValue(index)) ?? new Set<string>();
      index += 1;
      continue;
    }
    if (arg === "--with-auth" || arg === "--require-auth") {
      requireAuth = true;
      continue;
    }
    if (arg === "--all-providers" || arg === "--no-auth-filter") {
      requireAuth = false;
      continue;
    }
    if (arg.startsWith("--")) {
      passthroughArgs.push(arg);
      const next = argv[index + 1];
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

  return {
    suites: (suites.size ? [...suites] : DEFAULT_SUITES).toSorted(),
    globalProviders,
    suiteProviders,
    requireAuth,
    quietArgs,
    passthroughArgs,
    help,
  };
}

function selectProviders(params: {
  suite: MediaSuiteConfig;
  globalProviders: Set<string> | null;
  suiteProviders: Set<string> | undefined;
  requireAuth: boolean;
}): string[] {
  const explicit = params.suiteProviders ?? params.globalProviders;
  const candidates = explicit
    ? params.suite.providers
    : (params.suite.defaultProviders ?? params.suite.providers);
  let providers = candidates.filter((provider) => (explicit ? explicit.has(provider) : true));
  if (!params.requireAuth) {
    return providers;
  }
  providers = providers.filter((provider) => collectProviderApiKeys(provider).length > 0);
  return providers;
}

export function buildRunPlan(options: CliOptions): SuiteRunPlan[] {
  const expectedKeys = [
    ...new Set(
      options.suites.flatMap((suiteId) =>
        MEDIA_SUITES[suiteId].providers.flatMap((provider) => getProviderEnvVars(provider)),
      ),
    ),
  ];
  if (expectedKeys.length) {
    loadShellEnvFallback({
      enabled: true,
      env: process.env,
      expectedKeys,
      logger: { warn: (message: string) => console.warn(message) },
    });
  }

  return options.suites.map((suiteId) => {
    const suite = MEDIA_SUITES[suiteId];
    const providers = selectProviders({
      suite,
      globalProviders: options.globalProviders,
      suiteProviders: options.suiteProviders[suiteId],
      requireAuth: options.requireAuth,
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
  });
}

function printHelp(): void {
  console.log(`Media live harness

Usage:
  pnpm test:live:media
  pnpm test:live:media image
  pnpm test:live:media image video --providers openai,google,minimax
  pnpm test:live:media video --video-providers openai,runway --all-providers

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
  --quiet | --no-quiet      passed through to test:live
`);
}

async function runSuite(params: {
  plan: SuiteRunPlan;
  quietArgs: string[];
  passthroughArgs: string[];
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

export async function runCli(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const plan = buildRunPlan(options);
  const runnable = plan.filter((entry) => entry.providers.length > 0);
  const skipped = plan.filter((entry) => entry.providers.length === 0);

  for (const entry of skipped) {
    console.log(
      `[live:media] skip ${entry.suite.id}: ${entry.skippedReason ?? "no providers selected"}`,
    );
  }
  if (runnable.length === 0) {
    console.log("[live:media] nothing to run");
    return 0;
  }

  for (const entry of runnable) {
    const exitCode = await runSuite({
      plan: entry,
      quietArgs: options.quietArgs,
      passthroughArgs: options.passthroughArgs,
    });
    if (exitCode !== 0) {
      return exitCode;
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exit(1);
    });
}
