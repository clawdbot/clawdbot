// Telegram bot-token runtime evidence starts the real monitor through getMe.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { monitorTelegramProvider } from "../../../../extensions/telegram/runtime-api.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const STARTUP_TIMEOUT_MS = 30_000;
const TOKEN_ENV_KEYS = [
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  "TELEGRAM_E2E_SUT_BOT_TOKEN",
] as const;

type TelegramRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
  startupTimeoutMs: number;
};

async function waitForMonitorShutdown(monitorPromise: Promise<void>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Telegram runtime shutdown timed out")), timeoutMs);
  });
  try {
    await Promise.race([monitorPromise.catch(() => undefined), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseOptions(argv: string[], repoRoot = process.cwd()): TelegramRuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "telegram-bot-token");
  let startupTimeoutMs = STARTUP_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = path.resolve(repoRoot, argv[++index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      startupTimeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return { artifactBase, repoRoot, startupTimeoutMs };
}

function resolveLeasedToken(env: NodeJS.ProcessEnv = process.env) {
  for (const key of TOKEN_ENV_KEYS) {
    const token = env[key]?.trim();
    if (token) {
      return { key, token };
    }
  }
  return undefined;
}

function createWriter(options: TelegramRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "telegram-bot-token.log",
    primaryModel: "telegram/bot-api",
    providerMode: "live-frontier",
    repoRoot: options.repoRoot,
    target: {
      id: "telegram-bot-token",
      title: "Telegram bot token runtime startup",
      sourcePath: "test/e2e/qa-lab/runtime/telegram-bot-token-runtime.ts",
      docsRefs: ["docs/channels/telegram.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/telegram-bot-token-runtime.ts",
        "extensions/telegram/src/monitor.ts",
        "extensions/telegram/src/polling-session.ts",
      ],
    },
  });
}

async function waitForStartup(params: {
  abortController: AbortController;
  monitorPromise: Promise<void>;
  startupPromise: Promise<void>;
  timeoutMs: number;
}) {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Telegram runtime startup timed out")),
      params.timeoutMs,
    );
  });
  try {
    await Promise.race([
      params.startupPromise,
      params.monitorPromise.then(() => {
        throw new Error("Telegram runtime stopped before polling startup");
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    params.abortController.abort();
    await waitForMonitorShutdown(params.monitorPromise, params.timeoutMs);
  }
}

export async function runTelegramBotTokenRuntime(
  options: TelegramRuntimeOptions,
  env: NodeJS.ProcessEnv = process.env,
) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const credential = resolveLeasedToken(env);
  if (!credential) {
    writer.appendLog(`telegram-bot-token: blocked; none of ${TOKEN_ENV_KEYS.join(", ")} is set\n`);
    return await writer.write({
      details: "Telegram runtime proof requires a leased bot token",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "blocked",
    });
  }

  writer.appendLog(`telegram-bot-token: using leased credential from ${credential.key}\n`);
  const abortController = new AbortController();
  let markStarted: (() => void) | undefined;
  const startupPromise = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const runtime: RuntimeEnv = {
    log: (...args) => {
      const line = args.map(String).join(" ");
      writer.appendLog(`${line}\n`);
      if (
        line.includes("isolated polling ingress started") ||
        line.includes("polling cycle started")
      ) {
        markStarted?.();
      }
    },
    error: (...args) => writer.appendLog(`${args.map(String).join(" ")}\n`),
    exit: (code) => {
      throw new Error(`Telegram runtime requested exit ${code}`);
    },
  };
  const config: OpenClawConfig = {
    channels: { telegram: { enabled: true } },
  };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(options.artifactBase, "state");
  try {
    const monitorPromise = monitorTelegramProvider({
      abortSignal: abortController.signal,
      config,
      isolatedIngress: { enabled: true },
      runtime,
      token: credential.token,
    });
    await waitForStartup({
      abortController,
      monitorPromise,
      startupPromise,
      timeoutMs: options.startupTimeoutMs,
    });
    writer.appendLog("telegram-bot-token: runtime started after Telegram getMe\n");
    return await writer.write({
      details: `Telegram runtime startup completed with ${credential.key}`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`telegram-bot-token: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  }
}

export const testing = { parseOptions, resolveLeasedToken, waitForMonitorShutdown };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runTelegramBotTokenRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`telegram-bot-token: ${status}\n`);
      process.exitCode = status === "fail" ? 1 : 0;
    })
    .catch((error: unknown) => {
      process.stderr.write(`telegram-bot-token: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
