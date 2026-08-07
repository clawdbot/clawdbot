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
} from "../../gateway/test-helpers.js";
import { testConfigRoot } from "../../gateway/test-helpers.runtime-state.js";

installGatewayTestHooks({ scope: "suite" });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = path.join(repoRoot, "src/entry.ts");
const CLI_CHILD_TIMEOUT_MS = 60_000;

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        Object.assign(new Error("CLI process did not exit before the deadlock guard"), {
          stdout,
          stderr,
        }),
      );
    }, CLI_CHILD_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
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
  const token = "proof-trigger-once-token";

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trigger-once-proof-"));
    // Allow trigger payloads on cron.add without enabling the scheduler /
    // trigger-watcher lifecycle (default SKIP_CRON + cronEnabled=false).
    const configPath = path.join(testConfigRoot.value, "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ cron: { triggers: { enabled: true } } }, null, 2)}\n`,
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
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("CLI --trigger-script keeps existing trigger.once=true", async () => {
    expect(started).toBeDefined();
    const { ws, port } = started!;
    const url = `ws://127.0.0.1:${port}`;
    // Keep the spawned source-entry CLI single-process: host CI may export
    // NODE_COMPILE_CACHE / VITEST from the runner.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempRoot,
      OPENCLAW_HOME: tempRoot,
      OPENCLAW_STATE_DIR: path.join(tempRoot, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(tempRoot, ".openclaw", "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: token,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_NO_RESPAWN: "1",
    };
    delete env.OPENCLAW_GATEWAY_PORT;
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_COMPILE_CACHE_PORTABLE;
    delete env.VITEST;
    delete env.NODE_OPTIONS;

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
