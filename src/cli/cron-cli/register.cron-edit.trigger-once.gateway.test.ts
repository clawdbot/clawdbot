// Exact-head CLI → ephemeral gateway proof: --trigger-script preserves trigger.once.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "../../gateway/test-helpers.js";
import { testConfigRoot } from "../../gateway/test-helpers.runtime-state.js";

installGatewayTestHooks({ scope: "suite" });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = path.join(repoRoot, "src/entry.ts");

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function jobIdFromCronAdd(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as { id?: unknown; job?: { id?: unknown } };
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  if (typeof record.job?.id === "string" && record.job.id.trim()) {
    return record.job.id.trim();
  }
  return "";
}

describe("cron edit trigger-once CLI→gateway", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
  let tempRoot = "";
  let previousCronEnabled: boolean | undefined;
  const token = "proof-trigger-once-token";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trigger-once-proof-"));
    previousCronEnabled = testState.cronEnabled;
    process.env.OPENCLAW_SKIP_CRON = "0";
    testState.cronEnabled = true;
    const configPath = path.join(testConfigRoot.value, "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          cron: {
            enabled: true,
            triggers: { enabled: true },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    started = await startServerWithClient(token);
    await connectOk(started.ws);
  }, 120_000);

  afterAll(async () => {
    if (started) {
      started.ws.close();
      await started.server.close().catch(() => undefined);
      started.envSnapshot.restore();
    }
    testState.cronEnabled = previousCronEnabled;
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("CLI --trigger-script keeps existing trigger.once=true", async () => {
    expect(started).toBeDefined();
    const { ws, port } = started!;
    const url = `ws://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      HOME: tempRoot,
      OPENCLAW_HOME: tempRoot,
      OPENCLAW_STATE_DIR: path.join(tempRoot, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(tempRoot, ".openclaw", "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: token,
    };

    const add = await rpcReq(ws, "cron.add", {
      name: "proof-trigger-once",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "wake" },
      trigger: {
        script: "return { fire: false };",
        once: true,
      },
    });
    expect(add.ok, JSON.stringify(add.error ?? add.payload)).toBe(true);
    const jobId = jobIdFromCronAdd(add.payload);
    expect(jobId.length > 0).toBe(true);

    const nextScriptPath = path.join(tempRoot, "next-trigger.js");
    await fs.writeFile(nextScriptPath, "return { fire: true };\n", "utf8");

    const edit = await runCli(
      ["cron", "edit", jobId, "--trigger-script", nextScriptPath, "--url", url, "--token", token],
      env,
    );
    console.log(
      [
        "----- cli-edit-trigger-script-preserve-once -----",
        `$ openclaw cron edit ${jobId} --trigger-script next-trigger.js --url ${url} --token ***`,
        edit.stdout.trim(),
        edit.stderr.trim(),
        `exit=${edit.code}`,
      ].join("\n"),
    );
    expect(edit.code, `${edit.stdout}\n${edit.stderr}`).toBe(0);

    const get = await rpcReq(ws, "cron.get", { id: jobId });
    expect(get.ok, JSON.stringify(get.error ?? get.payload)).toBe(true);
    const job = get.payload as {
      trigger?: { script?: string; once?: boolean };
    };
    expect(job.trigger?.once).toBe(true);
    expect(job.trigger?.script).toContain("fire: true");
    console.log(
      [
        "----- gateway-cron-get-trigger -----",
        JSON.stringify({ id: jobId, trigger: job.trigger }, null, 2),
      ].join("\n"),
    );
  }, 120_000);
});
