// Live Daytona backend E2E. Gated behind OPENCLAW_E2E_DAYTONA=1 plus a real
// DAYTONA_API_KEY because it creates and deletes a real cloud sandbox.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDaytonaSandboxBackendFactory,
  createDaytonaSandboxBackendManager,
} from "./backend.js";
import { createDaytonaClient, resolveDaytonaConnection } from "./client.js";
import { resolveDaytonaPluginConfig } from "./config.js";

type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

const E2E_ENABLED =
  process.env.OPENCLAW_E2E_DAYTONA === "1" && Boolean(process.env.DAYTONA_API_KEY);
const E2E_TIMEOUT_MS = 12 * 60 * 1000;

const pluginConfig = resolveDaytonaPluginConfig({
  ...(process.env.OPENCLAW_E2E_DAYTONA_SNAPSHOT
    ? { snapshot: process.env.OPENCLAW_E2E_DAYTONA_SNAPSHOT }
    : {}),
  autoDeleteInterval: 60,
});
const hostConfig = {} as OpenClawConfig;
const createdRuntimeIds: string[] = [];
const tempDirs: string[] = [];

afterAll(async () => {
  const manager = createDaytonaSandboxBackendManager({ pluginConfig, hostConfig });
  for (const runtimeId of createdRuntimeIds) {
    await manager
      .removeRuntime({
        entry: {
          containerName: runtimeId,
          sessionKey: "agent:daytona-e2e",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "default",
        },
        config: hostConfig,
      })
      .catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 120_000);

async function createLiveParams(): Promise<CreateSandboxBackendParams> {
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daytona-e2e-")),
  );
  tempDirs.push(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "seed-marker.txt"), "seeded-by-openclaw");
  return {
    sessionKey: "agent:daytona-e2e:turn",
    scopeKey: "agent:daytona-e2e",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: {
      mode: "all",
      backend: "daytona",
      scope: "agent",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      dockerTmpfsSource: "configured",
      docker: {
        image: "openclaw-sandbox:bookworm-slim",
        containerPrefix: "openclaw-sbx-",
        workdir: "/workspace",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        binds: [],
        env: {},
      },
      ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
      browser: createSandboxBrowserConfig(),
      tools: { allow: ["*"], deny: [] },
      prune: createSandboxPruneConfig(),
    },
  };
}

async function runBackendExec(
  handle: SandboxBackendHandle,
  params: { command: string; usePty?: boolean; env?: Record<string, string> },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const spec = await handle.buildExecSpec({
    command: params.command,
    env: params.env ?? {},
    usePty: params.usePty ?? false,
  });
  const [executable, ...args] = spec.argv;
  if (!executable) {
    throw new Error("empty exec argv");
  }
  const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.stdin.end();
      child.on("close", (code) => {
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    },
  );
  await handle.finalizeExec?.({
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    timedOut: false,
    token: spec.finalizeToken,
  });
  return result;
}

describe("daytona backend live e2e", () => {
  // Image-based creates pull the image on first use, so this heavier path is
  // double-gated: OPENCLAW_E2E_DAYTONA=1 plus OPENCLAW_E2E_DAYTONA_IMAGE=1.
  it.runIf(E2E_ENABLED && process.env.OPENCLAW_E2E_DAYTONA_IMAGE === "1")(
    "provisions an image-based sandbox with explicit resources",
    async () => {
      const imagePluginConfig = resolveDaytonaPluginConfig({
        image: "python:3.13-slim",
        resources: { cpu: 1, memory: 2, disk: 5 },
        autoDeleteInterval: 60,
      });
      const factory = createDaytonaSandboxBackendFactory({
        pluginConfig: imagePluginConfig,
        hostConfig,
      });
      const params = await createLiveParams();

      const handle = await factory(params);
      createdRuntimeIds.push(handle.runtimeId);
      expect(handle.configLabel).toBe("python:3.13-slim");
      expect(handle.configLabelKind).toBe("Image");

      const probe = await runBackendExec(handle, {
        command: "python3 --version && cat seed-marker.txt && nproc",
      });
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout).toContain("Python 3.13");
      expect(probe.stdout).toContain("seeded-by-openclaw");

      const manager = createDaytonaSandboxBackendManager({
        pluginConfig: imagePluginConfig,
        hostConfig,
      });
      await manager.removeRuntime({
        entry: {
          containerName: handle.runtimeId,
          sessionKey: params.scopeKey,
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
          image: handle.configLabel ?? "default",
        },
        config: hostConfig,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it.runIf(E2E_ENABLED)(
    "provisions, executes, bridges files, adopts, and removes a real sandbox",
    async () => {
      const factory = createDaytonaSandboxBackendFactory({ pluginConfig, hostConfig });
      const params = await createLiveParams();

      const handle = await factory(params);
      createdRuntimeIds.push(handle.runtimeId);

      // Exec lands in the Daytona sandbox with the seeded workspace as cwd.
      const uname = await runBackendExec(handle, {
        command: "uname -a && cat seed-marker.txt && printf '%s' \"$OC_E2E\"",
        env: { OC_E2E: "env-flows" },
      });
      expect(uname.exitCode).toBe(0);
      expect(uname.stdout).toContain("Linux");
      expect(uname.stdout).toContain("seeded-by-openclaw");
      expect(uname.stdout).toContain("env-flows");

      // Exit codes and stderr propagate.
      const failing = await runBackendExec(handle, {
        command: "printf 'to-stderr' >&2; exit 7",
      });
      expect(failing.exitCode).toBe(7);
      expect(failing.stderr).toContain("to-stderr");

      // PTY execs run through the Daytona PTY surface.
      const pty = await runBackendExec(handle, {
        command: "printf 'pty-marker'; exit 4",
        usePty: true,
      });
      expect(pty.exitCode).toBe(4);
      expect(pty.stdout).toContain("pty-marker");

      // Backend-owned workdir validation resolves real directories only.
      await expect(handle.validateWorkdir?.(pluginConfig.remoteWorkspaceDir)).resolves.toBe(
        pluginConfig.remoteWorkspaceDir,
      );
      await expect(handle.validateWorkdir?.("/definitely-missing")).resolves.toBeNull();

      // The fs bridge round-trips binary content without a host copy.
      const bridgeContext: SandboxFsBridgeContext = {
        workspaceDir: params.workspaceDir,
        agentWorkspaceDir: params.agentWorkspaceDir,
        workspaceAccess: "rw",
        containerName: handle.runtimeId,
        containerWorkdir: pluginConfig.remoteWorkspaceDir,
        docker: {},
        backend: { runShellCommand: (command) => handle.runShellCommand(command) },
      };
      const bridge = handle.createFsBridge?.({ sandbox: bridgeContext });
      if (!bridge) {
        throw new Error("daytona backend must provide an fs bridge");
      }
      const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f]);
      await bridge.writeFile({ filePath: "bridge/binary.bin", data: binary, mkdir: true });
      const roundTrip = await bridge.readFile({ filePath: "bridge/binary.bin" });
      expect([...roundTrip]).toEqual([...binary]);
      await expect(
        fs.stat(path.join(params.workspaceDir, "bridge", "binary.bin")),
      ).rejects.toThrow();
      const stat = await bridge.stat({ filePath: "bridge/binary.bin" });
      expect(stat).toMatchObject({ type: "file", size: binary.length });

      // An aborted mutation is killed remotely before the abort is reported:
      // the marker survives because the guarded rm never ran.
      await bridge.writeFile({ filePath: "abort-marker.txt", data: "survives" });
      const abortController = new AbortController();
      const abortedMutation = handle.runShellCommand({
        script: `sleep 5 && rm -f ${pluginConfig.remoteWorkspaceDir}/abort-marker.txt`,
        signal: abortController.signal,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      abortController.abort(new Error("live abort probe"));
      await expect(abortedMutation).rejects.toThrow("live abort probe");
      // Wait past the sleep window; if the remote command had survived the
      // abort, the marker would be gone by now.
      await new Promise((resolve) => {
        setTimeout(resolve, 6000);
      });
      const survivingMarker = await bridge.readFile({ filePath: "abort-marker.txt" });
      expect(survivingMarker.toString("utf8")).toBe("survives");

      // An auto-stopped sandbox restarts on the next use for both transports.
      const connection = await resolveDaytonaConnection({ config: hostConfig, pluginConfig });
      const client = await createDaytonaClient(connection);
      const liveSandbox = await client.get(handle.runtimeId);
      await liveSandbox.stop();
      const fsAfterStop = await handle.runShellCommand({ script: "printf fs-restarted" });
      expect(fsAfterStop.stdout.toString("utf8")).toBe("fs-restarted");
      await liveSandbox.stop();
      const execAfterStop = await runBackendExec(handle, { command: "printf exec-restarted" });
      expect(execAfterStop.exitCode).toBe(0);
      expect(execAfterStop.stdout).toContain("exec-restarted");

      // A fresh factory adopts the registered runtime instead of re-creating.
      const adopted = await factory({
        ...params,
        registeredRuntimeIds: [handle.runtimeId],
      });
      expect(adopted.runtimeId).toBe(handle.runtimeId);

      // Manager sees the live sandbox and removes it.
      const manager = createDaytonaSandboxBackendManager({ pluginConfig, hostConfig });
      const entry = {
        containerName: handle.runtimeId,
        sessionKey: params.scopeKey,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        image: handle.configLabel ?? "default",
      };
      await expect(manager.describeRuntime({ entry, config: hostConfig })).resolves.toMatchObject({
        running: true,
        configLabelMatch: true,
      });
      await manager.removeRuntime({ entry, config: hostConfig });
      await expect(manager.describeRuntime({ entry, config: hostConfig })).resolves.toMatchObject({
        running: false,
      });
    },
    E2E_TIMEOUT_MS,
  );
});
