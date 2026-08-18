// Process coverage for one-shot Gateway CLI output followed by clean exit.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadOriginDeviceTokenReadOnly,
  storeOriginDeviceToken,
} from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  closeActiveGatewayServers,
  EMPTY_STABILITY_SNAPSHOT,
  startAgentTurnGateway,
  startCronListGateway,
  startGatewayStabilityRpcServer,
  startNodePairingGateway,
  startRateLimitedGateway,
} from "./gateway-backed-exit.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const UNREACHABLE_GATEWAY_URL = "ws://127.0.0.1:9";
afterEach(async () => {
  await Promise.all(
    Array.from(activeChildren, async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        // Let the launcher forward termination to its respawned child.
        child.kill("SIGTERM");
        await once(child, "close");
      }
    }),
  );
  activeChildren.clear();
  await closeActiveGatewayServers();
});

async function snapshotDirectoryContents(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).toSorted()) {
      const absolutePath = path.join(directory, name);
      const relativePath = path.relative(root, absolutePath);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(absolutePath);
      } else if (stat.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await fs.readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = `file:${createHash("sha256")
          .update(await fs.readFile(absolutePath))
          .digest("hex")}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function snapshotSharedStateArtifacts(stateDir: string): Promise<Record<string, string>> {
  const sharedStateDir = path.join(stateDir, "state");
  try {
    return await snapshotDirectoryContents(sharedStateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function prepareUnreachableGatewayCliFixture(params: {
  label: string;
  seeded: boolean;
}): Promise<{ root: string; stateDir: string; configPath: string }> {
  const root = tempDirs.make(`openclaw-${params.label}-${params.seeded ? "seeded" : "absent"}-`);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "remote",
        auth: { mode: "none" },
        remote: { url: UNREACHABLE_GATEWAY_URL },
      },
    }),
  );
  if (params.seeded) {
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    storeOriginDeviceToken({
      gatewayScope: gatewayOriginScope(UNREACHABLE_GATEWAY_URL),
      deviceId: identity.deviceId,
      role: "operator",
      token: "stored-device-token",
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
  }
  return { root, stateDir, configPath };
}

function expectUnreachableGatewayTransportFailure(
  result: Awaited<ReturnType<typeof runIsolatedGatewayCli>>,
  output: "json" | "text",
): void {
  expect(result).toMatchObject({ code: 1, signal: null });
  if (output === "json") {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: expect.stringContaining("Gateway not reachable"),
      },
      gateway: { url: UNREACHABLE_GATEWAY_URL },
    });
    return;
  }
  expect(result.stderr).toContain("Gateway not reachable");
  expect(result.stderr).toContain(UNREACHABLE_GATEWAY_URL);
  expect(result.stderr).not.toContain("gateway timeout");
}

async function runIsolatedGatewayCli(params: {
  args: string[];
  root: string;
  stateDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...params.args],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          HOME: params.root,
          USERPROFILE: params.root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: params.configPath,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_HOME: params.root,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: params.stateDir,
          DISCORD_BOT_TOKEN: undefined,
          TWILIO_ACCOUNT_SID: undefined,
          TWILIO_AUTH_TOKEN: undefined,
          TWILIO_FROM_NUMBER: undefined,
          VITEST: undefined,
          ...params.env,
        },
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 20_000,
      },
    );
    return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code !== "number") {
      throw error;
    }
    return {
      code: failure.code,
      signal: failure.signal ?? null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("gateway-backed CLI process exit", () => {
  it.each([
    { status: "ok" as const, text: "pong", exitCode: 0 },
    { status: "error" as const, text: "provider failed", exitCode: 1 },
  ])(
    "exits $exitCode after an agent turn reports $status",
    async ({ status, text, exitCode }) => {
      const root = tempDirs.make(`openclaw-agent-turn-${status}-`);
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const gateway = await startAgentTurnGateway({ status, text });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            mode: "remote",
            remote: { url: gateway.url, token: gateway.token },
          },
        }),
      );

      const result = await runIsolatedGatewayCli({
        args: ["agent", "--agent", "main", "--message", "ping", "--json"],
        root,
        stateDir,
        configPath,
      });

      expect(result, result.stderr).toMatchObject({ code: exitCode, signal: null, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status,
        summary: status === "ok" ? "completed" : "failed",
        result: { payloads: [{ text }] },
      });
    },
    30_000,
  );

  it.each([
    {
      label: "root-health-json",
      args: ["health", "--json", "--timeout", "250"],
      output: "json" as const,
    },
    {
      label: "gateway-health-text",
      args: ["gateway", "health", "--timeout", "250"],
      output: "text" as const,
    },
    {
      label: "gateway-health-json",
      args: ["gateway", "health", "--json", "--timeout", "250"],
      output: "json" as const,
    },
    {
      label: "gateway-suspend-json",
      args: ["gateway", "suspend", "--json", "--timeout", "250"],
      output: "json" as const,
    },
    {
      label: "gateway-resume-json",
      args: ["gateway", "resume", "suspension-1", "--json", "--timeout", "250"],
      output: "json" as const,
    },
  ])(
    "leaves shared state byte-identical after unreachable $label",
    async ({ label, args, output }) => {
      const absent = await prepareUnreachableGatewayCliFixture({ label, seeded: false });
      expect(await snapshotSharedStateArtifacts(absent.stateDir)).toEqual({});

      const absentResult = await runIsolatedGatewayCli({ ...absent, args });

      expectUnreachableGatewayTransportFailure(absentResult, output);
      expect(await snapshotSharedStateArtifacts(absent.stateDir)).toEqual({});

      const seeded = await prepareUnreachableGatewayCliFixture({ label, seeded: true });
      const before = await snapshotSharedStateArtifacts(seeded.stateDir);
      expect(Object.keys(before)).toContain("openclaw.sqlite");

      const seededResult = await runIsolatedGatewayCli({ ...seeded, args });

      expectUnreachableGatewayTransportFailure(seededResult, output);
      expect(await snapshotSharedStateArtifacts(seeded.stateDir)).toEqual(before);
    },
    60_000,
  );

  it("dispatches node pairing mutations without opening the writable state database", async () => {
    const root = tempDirs.make("openclaw-node-pairing-cli-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const token = "test-token";
    const gateway = await startNodePairingGateway(token);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: "remote", remote: { url: gateway.url, token } },
      }),
    );

    const result = await runIsolatedGatewayCli({
      args: ["nodes", "approve", "request-1", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ approved: true });
    expect(gateway.calls).toEqual(["node.pair.list", "node.pair.approve"]);
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("uses existing device auth without persisting a hello-issued token or coordinator state", async () => {
    const root = tempDirs.make("openclaw-node-pairing-stored-auth-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const storedToken = "stored-device-token";
    const gateway = await startNodePairingGateway(storedToken, "issued-device-token");
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "remote", remote: { url: gateway.url } } }),
    );
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    storeOriginDeviceToken({
      gatewayScope: gatewayOriginScope(gateway.url),
      deviceId: identity.deviceId,
      role: "operator",
      token: storedToken,
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
    const before = await snapshotDirectoryContents(stateDir);

    const result = await runIsolatedGatewayCli({
      args: ["nodes", "approve", "request-1", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ approved: true });
    expect(gateway.calls).toEqual(["node.pair.list", "node.pair.approve"]);
    expect(await snapshotDirectoryContents(stateDir)).toEqual(before);
    expect(
      loadOriginDeviceTokenReadOnly({
        gatewayScope: gatewayOriginScope(gateway.url),
        deviceId: identity.deviceId,
        role: "operator",
        env: stateEnv,
      })?.token,
    ).toBe(storedToken);
  }, 30_000);

  it("calls a reachable Gateway with explicit auth without creating shared state", async () => {
    const root = tempDirs.make("openclaw-gateway-call-explicit-auth-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const token = "configured-token";
    const gateway = await startGatewayStabilityRpcServer(token, "issued-device-token");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "remote", remote: { url: gateway.url, token } } }),
    );
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual({});

    const result = await runIsolatedGatewayCli({
      args: ["gateway", "call", "diagnostics.stability", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(EMPTY_STABILITY_SNAPSHOT);
    expect(gateway.authTokens).toEqual([token]);
    expect(gateway.calls).toEqual(["diagnostics.stability"]);
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual({});
  }, 30_000);

  it("calls a reachable Gateway with stored auth without changing shared state", async () => {
    const root = tempDirs.make("openclaw-gateway-call-stored-auth-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const storedToken = "stored-device-token";
    const gateway = await startGatewayStabilityRpcServer(storedToken, "issued-device-token");
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "remote", remote: { url: gateway.url } } }),
    );
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    storeOriginDeviceToken({
      gatewayScope: gatewayOriginScope(gateway.url),
      deviceId: identity.deviceId,
      role: "operator",
      token: storedToken,
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
    const before = await snapshotSharedStateArtifacts(stateDir);

    const result = await runIsolatedGatewayCli({
      args: ["gateway", "call", "diagnostics.stability", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(EMPTY_STABILITY_SNAPSHOT);
    expect(gateway.authTokens).toEqual([storedToken]);
    expect(gateway.calls).toEqual(["diagnostics.stability"]);
    expect(
      loadOriginDeviceTokenReadOnly({
        gatewayScope: gatewayOriginScope(gateway.url),
        deviceId: identity.deviceId,
        role: "operator",
        env: stateEnv,
      })?.token,
    ).toBe(storedToken);
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual(before);
  }, 30_000);

  it.each([
    { label: "absent", seeded: false },
    { label: "seeded", seeded: true },
  ])(
    "requires a reachable status RPC without changing $label shared state",
    async ({ label, seeded }) => {
      const root = tempDirs.make(`openclaw-gateway-status-${label}-`);
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = "configured-token";
      const gateway = await startGatewayStabilityRpcServer(token, "issued-device-token");
      const stateEnv = {
        ...process.env,
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
      };
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { mode: "remote", remote: { url: gateway.url, token } } }),
      );
      if (seeded) {
        const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
        storeOriginDeviceToken({
          gatewayScope: gatewayOriginScope(gateway.url),
          deviceId: identity.deviceId,
          role: "operator",
          token,
          scopes: ["operator.admin"],
          env: stateEnv,
        });
        closeOpenClawStateDatabaseForTest();
      }
      const before = await snapshotSharedStateArtifacts(stateDir);
      expect(Object.keys(before).includes("openclaw.sqlite")).toBe(seeded);

      const result = await runIsolatedGatewayCli({
        args: [
          "gateway",
          "status",
          "--url",
          gateway.url,
          "--token",
          token,
          "--require-rpc",
          "--json",
          "--timeout",
          "2000",
        ],
        root,
        stateDir,
        configPath,
      });

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        rpc: { ok: true, kind: "read" },
      });
      expect(gateway.calls).toEqual(["status"]);
      expect(await snapshotSharedStateArtifacts(stateDir)).toEqual(before);
    },
    30_000,
  );

  it.each([
    { label: "list", args: ["devices", "list", "--timeout", "250"] },
    { label: "join-code", args: ["devices", "join-code", "--timeout", "250"] },
    {
      label: "remove",
      args: ["devices", "remove", "test-device", "--timeout", "250"],
    },
    {
      label: "clear",
      args: ["devices", "clear", "--yes", "--pending", "--timeout", "250"],
    },
    {
      label: "approve",
      args: ["devices", "approve", "test-request", "--timeout", "250"],
    },
    {
      label: "reject",
      args: ["devices", "reject", "test-request", "--timeout", "250"],
    },
    {
      label: "rename",
      args: [
        "devices",
        "rename",
        "--device",
        "test-device",
        "--name",
        "Test Device",
        "--timeout",
        "250",
      ],
    },
    {
      label: "rotate",
      args: [
        "devices",
        "rotate",
        "--device",
        "test-device",
        "--role",
        "operator",
        "--timeout",
        "250",
      ],
      machineOutput: true,
    },
    {
      label: "revoke",
      args: [
        "devices",
        "revoke",
        "--device",
        "test-device",
        "--role",
        "operator",
        "--timeout",
        "250",
      ],
      machineOutput: true,
    },
  ])(
    "renders an unreachable gateway as expected guidance for devices $label",
    async ({ label, args, machineOutput }) => {
      const root = tempDirs.make(`openclaw-devices-${label}-transport-`);
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const port = await getFreePort();
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          gateway: { mode: "local", port, auth: { mode: "token", token: "test-token" } },
        })}\n`,
        "utf8",
      );

      const result = await runIsolatedGatewayCli({ args, root, stateDir, configPath });

      expect(result).toMatchObject({ code: 1, signal: null });
      if (machineOutput) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: expect.stringContaining("Gateway not reachable") },
        });
      } else {
        expect(result.stdout).toBe("");
      }
      expect(result.stderr).toContain(`Gateway not reachable at ws://127.0.0.1:${port}`);
      expect(result.stderr).toContain(
        "Start it with `openclaw gateway run` or check `openclaw gateway status`.",
      );
      expect(result.stderr).not.toContain("The CLI command failed");
      expect(result.stderr).not.toContain("Could not start the CLI");
      expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
      expect(result.stderr).not.toContain("Stack:");
      expect(result.stderr).not.toContain("openclaw doctor");
    },
    30_000,
  );

  it.each([
    { label: "absent", seeded: false },
    { label: "seeded", seeded: true },
  ])(
    "exports diagnostics without changing $label shared state",
    async ({ label, seeded }) => {
      const fixture = await prepareUnreachableGatewayCliFixture({
        label: `gateway-diagnostics-export-${label}`,
        seeded,
      });
      const outputPath = path.join(fixture.root, "diagnostics.zip");
      const before = await snapshotSharedStateArtifacts(fixture.stateDir);

      const result = await runIsolatedGatewayCli({
        ...fixture,
        args: [
          "gateway",
          "diagnostics",
          "export",
          "--json",
          "--no-stability-bundle",
          "--output",
          outputPath,
        ],
      });

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      const payload = JSON.parse(result.stdout) as { bytes?: unknown; path?: unknown };
      expect(payload.path).toBe(outputPath);
      expect(payload.bytes).toEqual(expect.any(Number));
      expect(payload.bytes).toBeGreaterThan(0);
      const outputStat = await fs.stat(outputPath);
      expect(outputStat.isFile()).toBe(true);
      expect(outputStat.size).toBe(payload.bytes);
      expect(await snapshotSharedStateArtifacts(fixture.stateDir)).toEqual(before);
    },
    30_000,
  );

  it("rejects invalid remote config before a node pairing mutation without opening state", async () => {
    const root = tempDirs.make("openclaw-node-pairing-invalid-config-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const gateway = await startNodePairingGateway("test-token");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "remtoe",
          remote: { url: gateway.url, token: "test-token" },
        },
      }),
    );

    const result = await runIsolatedGatewayCli({
      args: ["nodes", "approve", "request-1", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(result.stderr).toContain("OpenClaw config is invalid");
    expect(result.stderr).toContain("gateway.mode");
    expect(gateway.calls).toEqual([]);
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("exits promptly after cron list emits complete output", async () => {
    const root = tempDirs.make("openclaw-gateway-cli-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const caTriggerPath = path.join(root, "load-default-ca.mjs");
    const token = "test-token";
    const gateway = await startCronListGateway(token);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      caTriggerPath,
      `if (process.env.OPENCLAW_NODE_OPTIONS_READY === "1") {
  const { getCACertificates } = await import("node:tls");
  getCACertificates("default");
}
`,
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: "remote", remote: { url: gateway.url, token } },
      }),
    );

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(caTriggerPath).href,
        "src/entry.ts",
        "cron",
        "list",
        "--json",
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          HOME: root,
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NODE_USE_SYSTEM_CA: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_NODE_OPTIONS_READY: undefined,
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    activeChildren.add(child);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let exitTimer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      once(child, "close").then(([code, signal]) => ({ code, signal })),
      new Promise<never>((_, reject) => {
        exitTimer = setTimeout(
          () => reject(new Error("cron list did not exit within 10 seconds")),
          10_000,
        );
        exitTimer.unref();
      }),
    ]).finally(() => {
      if (exitTimer) {
        clearTimeout(exitTimer);
      }
    });
    activeChildren.delete(child);

    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ jobs: [], total: 0 });
  }, 20_000);

  it("keeps gateway auth failures machine-readable through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-auth-json-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const port = await getFreePort();
    await fs.mkdir(stateDir, { recursive: true });

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "250"],
      root,
      stateDir,
      configPath,
      env: { OPENCLAW_GATEWAY_PORT: String(port) },
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: expect.stringContaining("requires"),
      },
    });
  }, 30_000);

  it.each([
    {
      label: "device list",
      args: ["devices", "list"],
      gatewayOwnsLock: false,
      method: "device.pair.list",
    },
    {
      label: "skills workshop apply",
      args: ["skills", "workshop", "apply", "proposal-missing-credentials"],
      gatewayOwnsLock: true,
      method: "health",
    },
  ])(
    "renders missing $label credentials as expected guidance, not a crash",
    async ({ label, args, gatewayOwnsLock, method }) => {
      const root = tempDirs.make(`openclaw-${label.replaceAll(" ", "-")}-credentials-human-`);
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const port = await getFreePort();
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port } })}\n`,
        "utf8",
      );

      const lock = gatewayOwnsLock
        ? await acquireGatewayLock({
            allowInTests: true,
            env: {
              ...process.env,
              HOME: root,
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_HOME: root,
              OPENCLAW_STATE_DIR: stateDir,
            },
            port,
            role: "gateway",
            timeoutMs: 1_000,
          })
        : null;
      if (gatewayOwnsLock) {
        expect(lock).not.toBeNull();
      }
      try {
        const result = await runIsolatedGatewayCli({ args, root, stateDir, configPath });

        expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
        expect(result.stderr).toContain(
          `gateway ${method} requires credentials before opening a websocket`,
        );
        expect(result.stderr).toContain(
          "Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.",
        );
        expect(result.stderr).toContain(`Config: ${configPath}`);
        expect(result.stderr).not.toContain("The CLI command failed");
        expect(result.stderr).not.toContain("Could not start the CLI");
        expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
        expect(result.stderr).not.toContain("Stack:");
        expect(result.stderr).not.toContain("openclaw doctor");
      } finally {
        await lock?.release();
      }
    },
    30_000,
  );

  it.each([
    { label: "channels config-only status", args: ["channels", "status"] },
    { label: "gateway reachability status", args: ["gateway", "status"] },
  ])(
    "returns success after delivering $label",
    async ({ args }) => {
      const root = tempDirs.make("openclaw-degraded-status-");
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const port = await getFreePort();
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port } })}\n`,
        "utf8",
      );

      const result = await runIsolatedGatewayCli({ args, root, stateDir, configPath });

      expect(result.code, result.stderr).toBe(0);
    },
    30_000,
  );

  it("preserves pre-hello rate-limit details through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-rate-limit-json-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const gateway = await startRateLimitedGateway();
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "remote",
          remote: { url: gateway.url, token: "test-token" },
        },
      }),
    );

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "2000"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "AUTH_RATE_LIMITED",
        message:
          "Gateway authentication is temporarily rate-limited. Wait for the temporary lockout to expire, then retry.",
        retryable: true,
        retryAfterMs: 60_000,
      },
      gateway: { reachable: true },
    });
    expect(result.stdout).not.toContain("gateway.remote.token");
    expect(result.stdout).not.toContain("devices rotate");
  }, 30_000);
});
