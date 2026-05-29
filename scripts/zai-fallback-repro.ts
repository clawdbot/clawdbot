import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

type RunResult = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

type OutputCapture = {
  text: string;
  truncatedChars: number;
};

type PnpmCommand = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

type ResolvePnpmCommandOptions = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
};

const COMMAND_OUTPUT_MAX_CHARS = 512 * 1024;

function resolveEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function appendBoundedReproOutput(
  capture: OutputCapture,
  chunk: unknown,
  maxChars = COMMAND_OUTPUT_MAX_CHARS,
): OutputCapture {
  const nextText = capture.text + String(chunk);
  if (nextText.length <= maxChars) {
    return { text: nextText, truncatedChars: capture.truncatedChars };
  }
  const truncatedChars = capture.truncatedChars + nextText.length - maxChars;
  return { text: nextText.slice(-maxChars), truncatedChars };
}

function formatBoundedReproOutput(capture: OutputCapture): string {
  if (capture.truncatedChars === 0) {
    return capture.text;
  }
  return `[output truncated ${capture.truncatedChars} chars; showing tail]\n${capture.text}`;
}

export function resolveZaiFallbackPnpmCommand(
  args: string[],
  options: ResolvePnpmCommandOptions = {},
): PnpmCommand {
  const env = options.env ?? process.env;
  const command = resolvePnpmRunner({
    comSpec: options.comSpec ?? resolveEnvValue(env, "ComSpec"),
    npmExecPath: options.npmExecPath ?? env.npm_execpath,
    nodeExecPath: options.execPath ?? process.execPath,
    platform: options.platform,
    pnpmArgs: args,
  });
  if (command.env === undefined) {
    const invocation = { ...command };
    delete invocation.env;
    return invocation;
  }
  return command;
}

function pickAnthropicEnv(): { type: "oauth" | "api"; value: string } | null {
  const oauth = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (oauth) {
    return { type: "oauth", value: oauth };
  }
  const api = process.env.ANTHROPIC_API_KEY?.trim();
  if (api) {
    return { type: "api", value: api };
  }
  return null;
}

function pickZaiKey(): string | null {
  return process.env.ZAI_API_KEY?.trim() ?? process.env.Z_AI_API_KEY?.trim() ?? null;
}

async function runCommand(
  label: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const command = resolveZaiFallbackPnpmCommand(args, { env });
    const child = spawn(command.command, command.args, {
      env: command.env ?? env,
      shell: command.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    let stdout: OutputCapture = { text: "", truncatedChars: 0 };
    let stderr: OutputCapture = { text: "", truncatedChars: 0 };
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBoundedReproOutput(stdout, text);
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr = appendBoundedReproOutput(stderr, text);
      process.stderr.write(text);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: formatBoundedReproOutput(stdout),
        stderr: formatBoundedReproOutput(stderr),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      resolve(result);
      const summary = signal
        ? `${label} exited with signal ${signal}`
        : `${label} exited with code ${code}`;
      console.error(summary);
    });
  });
}

async function main() {
  const anthropic = pickAnthropicEnv();
  const zaiKey = pickZaiKey();
  if (!anthropic) {
    console.error("Missing ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  if (!zaiKey) {
    console.error("Missing ZAI_API_KEY or Z_AI_API_KEY.");
    process.exit(1);
  }

  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-fallback-"));
  const stateDir = path.join(baseDir, "state");
  const configPath = path.join(baseDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });

  const config = {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["zai/glm-4.7"],
        },
        models: {
          "anthropic/claude-opus-4-6": {},
          "anthropic/claude-opus-4-5": {},
          "zai/glm-4.7": {},
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const sessionId = process.env.OPENCLAW_ZAI_FALLBACK_SESSION_ID ?? randomUUID();

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    ZAI_API_KEY: zaiKey,
    Z_AI_API_KEY: "",
  };

  const envValidAnthropic: NodeJS.ProcessEnv = {
    ...baseEnv,
    ANTHROPIC_OAUTH_TOKEN: anthropic.type === "oauth" ? anthropic.value : "",
    ANTHROPIC_API_KEY: anthropic.type === "api" ? anthropic.value : "",
  };

  const envInvalidAnthropic: NodeJS.ProcessEnv = {
    ...baseEnv,
    ANTHROPIC_OAUTH_TOKEN: anthropic.type === "oauth" ? "invalid" : "",
    ANTHROPIC_API_KEY: anthropic.type === "api" ? "invalid" : "",
  };

  console.log("== Run 1: create tool history (primary only)");
  const toolPrompt =
    "Use the exec tool to create a file named zai-fallback-tool.txt with the content tool-ok. " +
    "Then use the read tool to display the file contents. Reply with just the file contents.";
  const run1 = await runCommand(
    "run1",
    ["openclaw", "agent", "--local", "--session-id", sessionId, "--message", toolPrompt],
    envValidAnthropic,
  );
  if (run1.code !== 0) {
    process.exit(run1.code ?? 1);
  }

  const sessionFile = path.join(stateDir, "agents", "main", "sessions", `${sessionId}.jsonl`);
  const transcript = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!transcript.includes('"toolResult"')) {
    console.warn("Warning: no toolResult entries detected in session history.");
  }

  console.log("== Run 2: force auth failover to Z.AI");
  const followupPrompt =
    "What is the content of zai-fallback-tool.txt? Reply with just the contents.";
  const run2 = await runCommand(
    "run2",
    ["openclaw", "agent", "--local", "--session-id", sessionId, "--message", followupPrompt],
    envInvalidAnthropic,
  );

  if (run2.code === 0) {
    console.log("PASS: fallback succeeded.");
    process.exit(0);
  }

  console.error("FAIL: fallback failed.");
  process.exit(run2.code ?? 1);
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
