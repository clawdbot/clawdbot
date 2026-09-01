import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { getFreePort } from "../test-utils/ports.js";
import { compareCliGatewayStateDirs, type GatewayHello } from "./state-dir-gateway-check.js";

describe("state-dir guard with a real token Gateway", () => {
  const token = "state-dir-test-token";
  let child: ChildProcess;
  let root: string;
  let port: number;
  let gatewayStateDir: string;
  let cliStateDir: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-dir-server-"));
    gatewayStateDir = path.join(root, "gateway");
    cliStateDir = path.join(root, "cli");
    await fs.mkdir(gatewayStateDir, { recursive: true });
    await fs.mkdir(cliStateDir, { recursive: true });
    port = await getFreePort();
    const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
    await fs.writeFile(
      gatewayConfigPath,
      `${JSON.stringify({ gateway: { mode: "local", port, auth: { mode: "token", token } } })}\n`,
    );
    child = fork(
      fileURLToPath(
        new URL("./state-dir-gateway-check.server-fixture.test-support.ts", import.meta.url),
      ),
      [],
      {
        env: {
          ...process.env,
          HOME: path.join(root, "gateway-home"),
          OPENCLAW_STATE_DIR: gatewayStateDir,
          OPENCLAW_CONFIG_PATH: gatewayConfigPath,
          OPENCLAW_GATEWAY_PORT: String(port),
          OPENCLAW_TEST_GATEWAY_TOKEN: token,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        },
        execArgv: ["--import", path.resolve("scripts/tsx.mjs")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let childStderr = "";
    child.stderr?.on("data", (chunk) => {
      childStderr += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => {
        resolve();
      });
      child.once("exit", (code) => {
        reject(new Error(`Gateway fixture exited early: ${code}\n${childStderr}`));
      });
    });
  }, 120_000);

  afterAll(async () => {
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill("SIGTERM");
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("compares paths from an authenticated Gateway hello", async () => {
    let hello: GatewayHello | undefined;
    await callGateway({
      config: { gateway: { mode: "local", port, auth: { mode: "token", token } } },
      method: "status",
      params: { includeChannelSummary: false },
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
      // This bounds the live integration proof without changing the guard's 3s offline policy.
      timeoutMs: 60_000,
      onHelloOk: (value) => {
        hello = value;
      },
    });

    if (!hello?.snapshot.stateDir) {
      throw new Error("expected authenticated hello state paths");
    }
    expect(hello.snapshot).toMatchObject({
      stateDir: gatewayStateDir,
      configPath: path.join(gatewayStateDir, "openclaw.json"),
    });
    const gatewayPaths = {
      gatewayStateDir: hello.snapshot.stateDir,
      gatewayConfigPath: hello.snapshot.configPath,
      source: "live Gateway" as const,
      mode: "refuse" as const,
      command: "openclaw channels add",
    };
    expect(
      compareCliGatewayStateDirs({
        cliStateDir: gatewayStateDir,
        cliConfigPath: path.join(gatewayStateDir, "openclaw.json"),
        ...gatewayPaths,
      }),
    ).toEqual({ kind: "allow" });

    const mismatch = compareCliGatewayStateDirs({
      cliStateDir,
      cliConfigPath: path.join(cliStateDir, "openclaw.json"),
      ...gatewayPaths,
    });
    expect(mismatch).toMatchObject({ kind: "refuse" });
    if (mismatch.kind !== "refuse") {
      throw new Error("expected authenticated path mismatch refusal");
    }
    expect(mismatch.message).toContain(gatewayStateDir);
    expect(mismatch.message).toContain("live Gateway");
  }, 120_000);
});
