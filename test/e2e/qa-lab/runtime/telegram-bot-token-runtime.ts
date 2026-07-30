// Telegram startup evidence launches the real Gateway product path through getMe.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const STARTUP_TIMEOUT_MS = 30_000;
const LIVE_ACCOUNT_ID = "qa-live";
const PRODUCT_STARTUP_LOG = `[${LIVE_ACCOUNT_ID}] starting provider (@`;
const POLLING_STARTUP_LOGS = ["isolated polling ingress started", "polling cycle started"] as const;
const TOKEN_ENV_KEYS = [
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  "TELEGRAM_E2E_SUT_BOT_TOKEN",
] as const;

type TelegramRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
  startupTimeoutMs: number;
};

type TelegramProductStartupInstance = Pick<
  OpenClawTestInstance,
  "child" | "cleanup" | "logs" | "startGateway"
>;

type TelegramRuntimeDependencies = {
  createInstance: (
    options: Parameters<typeof createOpenClawTestInstance>[0],
  ) => Promise<TelegramProductStartupInstance>;
};

const defaultDependencies: TelegramRuntimeDependencies = {
  createInstance: createOpenClawTestInstance,
};

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

function sanitizeRuntimeLogs(logs: string, token: string) {
  if (!token) {
    return logs;
  }
  return logs
    .replaceAll(token, "[REDACTED_TELEGRAM_TOKEN]")
    .replaceAll(encodeURIComponent(token), "[REDACTED_TELEGRAM_TOKEN]");
}

async function waitForProductStartup(instance: TelegramProductStartupInstance, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const logs = instance.logs();
    const productStartupIndex = logs.indexOf(PRODUCT_STARTUP_LOG);
    const pollingStartupIndex = Math.min(
      ...POLLING_STARTUP_LOGS.map((marker) => {
        const index = logs.indexOf(marker);
        return index < 0 ? Number.POSITIVE_INFINITY : index;
      }),
    );
    if (
      productStartupIndex >= 0 &&
      Number.isFinite(pollingStartupIndex) &&
      pollingStartupIndex > productStartupIndex
    ) {
      return;
    }
    if (
      instance.child &&
      (instance.child.exitCode !== null || instance.child.signalCode !== null)
    ) {
      throw new Error("Telegram Gateway stopped before product startup completed");
    }
    await wait(50);
  }
  throw new Error("Telegram product startup getMe timed out before polling began");
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
    logFileName: "telegram-startup-getme-live.log",
    primaryModel: "telegram/bot-api",
    providerMode: "live-frontier",
    repoRoot: options.repoRoot,
    target: {
      id: "telegram-startup-getme-live",
      title: "Telegram product-startup getMe live",
      sourcePath: "test/e2e/qa-lab/runtime/telegram-bot-token-runtime.ts",
      docsRefs: ["docs/channels/telegram.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/telegram-bot-token-runtime.ts",
        "extensions/telegram/src/channel.ts",
        "extensions/telegram/src/probe.ts",
        "extensions/telegram/src/monitor.ts",
      ],
    },
  });
}

export async function runTelegramBotTokenRuntime(
  options: TelegramRuntimeOptions,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: TelegramRuntimeDependencies = defaultDependencies,
) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const credential = resolveLeasedToken(env);
  if (!credential) {
    writer.appendLog(
      `telegram-startup-getme: blocked; none of ${TOKEN_ENV_KEYS.join(", ")} is set\n`,
    );
    return await writer.write({
      details: "Telegram runtime proof requires a leased bot token",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "blocked",
    });
  }

  writer.appendLog(`telegram-startup-getme: using leased credential from ${credential.key}\n`);
  let instance: TelegramProductStartupInstance | undefined;
  try {
    instance = await dependencies.createInstance({
      name: "qa-telegram-startup-getme",
      config: {
        channels: {
          telegram: {
            enabled: true,
            defaultAccount: LIVE_ACCOUNT_ID,
            dmPolicy: "disabled",
            groupPolicy: "disabled",
            commands: { native: false, nativeSkills: false },
            accounts: {
              [LIVE_ACCOUNT_ID]: {
                enabled: true,
                botToken: credential.token,
              },
            },
          },
        },
      },
      env: {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        TELEGRAM_BOT_TOKEN: "qa-invalid-precedence-decoy",
      },
      startTimeoutMs: options.startupTimeoutMs,
    });
    await instance.startGateway();
    await waitForProductStartup(instance, options.startupTimeoutMs);
    writer.appendLog(sanitizeRuntimeLogs(instance.logs(), credential.token));
    writer.appendLog(
      "telegram-startup-getme: product startAccount resolved getMe bot identity before polling\n",
    );
    await instance.cleanup();
    instance = undefined;
    return await writer.write({
      details: `Telegram product-startup getMe completed with ${credential.key}`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = sanitizeRuntimeLogs(formatErrorMessage(error), credential.token);
    if (instance) {
      writer.appendLog(sanitizeRuntimeLogs(instance.logs(), credential.token));
    }
    writer.appendLog(`telegram-startup-getme: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    await instance?.cleanup().catch(() => undefined);
  }
}

export const testing = {
  parseOptions,
  resolveLeasedToken,
  sanitizeRuntimeLogs,
  waitForProductStartup,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runTelegramBotTokenRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`telegram-startup-getme: ${status}\n`);
      process.exitCode = status === "fail" ? 1 : 0;
    })
    .catch((error: unknown) => {
      process.stderr.write(`telegram-startup-getme: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
