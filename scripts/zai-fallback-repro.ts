import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function pickAnthropicEnv(): { type: "oauth" | "api"; value: string } | null {
  const oauth = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (oauth) return { type: "oauth", value: oauth };
  const api = process.env.ANTHROPIC_API_KEY?.trim();
  if (api) return { type: "api", value: api };
  return null;
}

function pickZaiKey(): string | null {
  return (
    process.env.ZAI_API_KEY?.trim() ?? process.env.Z_AI_API_KEY?.trim() ?? null
  );
}

async function runCommand(
  label: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ code, signal, stdout, stderr });
        return;
      }
      resolve({ code, signal, stdout, stderr });
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

  const baseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "moltbot-zai-fallback-"),
  );
  const stateDir = path.join(baseDir, "state");
  const configPath = path.join(baseDir, "moltbot.json");
  await fs.mkdir(stateDir, { recursive: true });

  const config = {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-opus-4-5",
          fallbacks: ["zai/glm-4.7"],
        },
        models: {
          "anthropic/claude-opus-4-5": {},
          "zai/glm-4.7": {},
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const sessionId =
    process.env.CLAWDBOT_ZAI_FALLBACK_SESSION_ID ?? randomUUID();

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWDBOT_CONFIG_PATH: configPath,
    CLAWDBOT_STATE_DIR: stateDir,
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
    [
      "moltbot",
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      toolPrompt,
    ],
    envValidAnthropic,
  );
  if (run1.code !== 0) {
    process.exit(run1.code ?? 1);
  }

  const sessionFile = path.join(
    stateDir,
    "agents",
    "main",
    "sessions",
    `${sessionId}.jsonl`,
  );
  const transcript = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!transcript.includes('"toolResult"')) {
    console.warn("Warning: no toolResult entries detected in session history.");
  }

  console.log("== Run 2: force auth failover to Z.AI");
  const followupPrompt =
    "What is the content of zai-fallback-tool.txt? Reply with just the contents.";
  const run2 = await runCommand(
    "run2",
    [
      "moltbot",
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      followupPrompt,
    ],
    envInvalidAnthropic,
  );

  if (run2.code === 0) {
    console.log("PASS: fallback succeeded.");
    process.exit(0);
  }

  console.error("FAIL: fallback failed.");
  process.exit(run2.code ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
