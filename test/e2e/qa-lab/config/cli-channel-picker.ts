// CLI channel picker producer drives the real onboarding prompt in an isolated home.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripAnsiSequences } from "../../../../packages/terminal-core/src/ansi.js";
import { createQaScriptEvidenceWriter } from "../runtime/script-evidence.js";

const SCENARIO_ID = "cli-channel-picker";
const SOURCE_PATH = "test/e2e/qa-lab/config/cli-channel-picker.ts";
const TEST_BOT_TOKEN = "123456:QA_CHANNEL_PICKER_TEST_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DEFAULT_TIMEOUT_MS = 120_000;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
  timeoutMs: number;
};

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizePickerTranscript(transcript: string) {
  return stripAnsiSequences(transcript).replaceAll(
    /123456(?:(?::|…)[A-Za-z0-9_…-]*)?/gu,
    "<test-token>",
  );
}

function parsePositiveInt(value: string, label: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return parsed;
}

function parseOptions(args: string[]): ProducerOptions {
  let artifactBase: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact-base") {
      artifactBase = args[++index];
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(args[++index] ?? "", "--timeout-ms");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd(), timeoutMs };
}

function buildCliStartup(repoRoot: string) {
  const result = spawnSync(process.execPath, ["scripts/build-all.mjs", "cliStartup"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`cliStartup build failed with exit code ${String(result.status)}`);
  }
}

async function runRealPicker(options: ProducerOptions, openclawHome: string) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const child = spawn(
    process.execPath,
    [
      "scripts/e2e/lib/run-with-pty.mjs",
      path.join(openclawHome, "picker.raw.log"),
      process.execPath,
      "openclaw.mjs",
      "configure",
      "--section",
      "channels",
    ],
    {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        CI: undefined,
        COLUMNS: "120",
        HOME: openclawHome,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_MESSAGES: "en_US.UTF-8",
        LINES: "40",
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_LOCALE: "en",
        OPENCLAW_STATE_DIR: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const waitFor = async (matcher: RegExp, fromIndex = 0) => {
    while (!matcher.test(stripAnsiSequences(output.slice(fromIndex)))) {
      if (spawnError) {
        throw spawnError;
      }
      if (exit) {
        throw new Error(
          `picker exited before output ${matcher}: code=${String(exit.code)} signal=${String(exit.signal)}`,
        );
      }
      if (remainingMs() === 0) {
        throw new Error(`picker timed out waiting for output: ${matcher}`);
      }
      await delay(Math.min(25, remainingMs()));
    }
  };
  const send = (input: string) => child.stdin.write(input);
  const sendAndWait = async (input: string, matcher: RegExp) => {
    const checkpoint = output.length;
    send(input);
    await waitFor(matcher, checkpoint);
  };

  try {
    await waitFor(/Channel setup[\s\S]*Add or update channels/u);
    await sendAndWait("\r", /Select a channel/u);

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const checkpoint = output.length;
      send("\u001b[B");
      await waitFor(/●\s+[^\r\n]+/u, checkpoint);
      if (/●\s+Telegram \(Bot API\)/u.test(stripAnsiSequences(output.slice(checkpoint)))) {
        break;
      }
      if (attempt === 63) {
        throw new Error("Telegram was not reachable from the real channel picker");
      }
    }

    await sendAndWait("\r", /How do you want to provide this Telegram bot token\?/u);
    await sendAndWait("\r", /◆\s+Enter Telegram bot token[\s\S]*│\s+_/u);
    await sendAndWait(`${TEST_BOT_TOKEN}\r`, /Telegram DM access warning[\s\S]*Select a channel/u);
    await sendAndWait("\u001b[A", /●\s+Finished \(Done\)/u);
    await sendAndWait("\r", /Configure DM access policies now\?/u);
    await sendAndWait("\r", /Configuration updated\./u);

    while (!exit) {
      if (remainingMs() === 0) {
        throw new Error(`picker timed out after ${options.timeoutMs}ms`);
      }
      await delay(Math.min(25, remainingMs()));
    }
    if (exit.code !== 0) {
      throw new Error(
        `picker exited unsuccessfully: code=${String(exit.code)} signal=${String(exit.signal)}`,
      );
    }
    return { durationMs: Math.max(1, Date.now() - startedAt), transcript: output };
  } catch (error) {
    if (!exit) {
      child.kill("SIGTERM");
      const cleanupDeadline = Date.now() + 5_000;
      while (!exit && Date.now() < cleanupDeadline) {
        await delay(25);
      }
    }
    throw error;
  }
}

function assertPickerConfig(config: unknown) {
  const value = config as {
    channels?: {
      telegram?: { botToken?: string; enabled?: boolean; groups?: Record<string, unknown> };
    };
    plugins?: { entries?: { telegram?: { enabled?: boolean } } };
    wizard?: { lastRunCommand?: string; lastRunMode?: string };
  };
  const telegram = value.channels?.telegram;
  const defaultGroup = telegram?.groups?.["*"] as { requireMention?: boolean } | undefined;
  if (value.plugins?.entries?.telegram?.enabled !== true) {
    throw new Error("picker did not enable the Telegram plugin");
  }
  if (telegram?.enabled !== true) {
    throw new Error("picker did not enable the Telegram channel");
  }
  if (telegram.botToken !== TEST_BOT_TOKEN) {
    throw new Error("picker did not write the entered Telegram bot token");
  }
  if (defaultGroup?.requireMention !== true) {
    throw new Error("picker did not write the Telegram default mention gate");
  }
  if (value.wizard?.lastRunCommand !== "configure" || value.wizard.lastRunMode !== "local") {
    throw new Error("picker did not persist configure wizard metadata");
  }
  return {
    channelEnabled: true,
    configPath: ".openclaw/openclaw.json",
    defaultGroupRequiresMention: true,
    pluginEnabled: true,
    selectedChannel: "telegram",
    wizardCommand: "configure",
    wizardMode: "local",
  };
}

function createEvidenceWriter(options: ProducerOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "cli-channel-picker.log",
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "CLI channel picker",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/channels/telegram.md", "docs/help/testing.md"],
      codeRefs: [SOURCE_PATH, "scripts/e2e/lib/run-with-pty.mjs", "src/flows/channel-setup.ts"],
    },
  });
}

async function runCliChannelPickerProducer(options: ProducerOptions) {
  const startedAt = Date.now();
  const writer = createEvidenceWriter(options);
  const workDir = path.join(options.artifactBase, ".work");
  const openclawHome = path.join(workDir, "openclaw-home");

  try {
    await fs.rm(workDir, { force: true, recursive: true });
    await fs.mkdir(openclawHome, { recursive: true });
    buildCliStartup(options.repoRoot);
    const result = await runRealPicker(options, openclawHome);
    writer.appendLog(sanitizePickerTranscript(result.transcript));
    const configPath = path.join(openclawHome, ".openclaw", "openclaw.json");
    const assertion = assertPickerConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
    await fs.writeFile(
      path.join(options.artifactBase, "config-assertion.json"),
      `${JSON.stringify(assertion, null, 2)}\n`,
      "utf8",
    );
    return await writer.write({
      artifacts: [{ kind: "config-assertion", filePath: "config-assertion.json" }],
      details: "real channel picker completed and persisted isolated Telegram configuration",
      durationMs: result.durationMs,
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`\nfail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
}

export const cliChannelPickerTestApi = {
  assertPickerConfig,
  sanitizePickerTranscript,
  testBotToken: TEST_BOT_TOKEN,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCliChannelPickerProducer(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      console.log(`CLI channel picker status: ${evidence.entries[0]?.result.status}`);
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
