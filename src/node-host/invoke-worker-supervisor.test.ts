import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../worker/node-workspace-transfer-protocol.js";
import { handleInvoke } from "./invoke.js";
import type { NodeWorkerBundleInstallerControl } from "./node-worker-bundle-installer.js";
import { NodeWorkerCapacityExhaustedError } from "./node-worker-capacity.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerSupervisorControl } from "./node-worker-supervisor-contract.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function launchInput() {
  const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-invoke-"));
  return testWorkerLaunchInput(fixture.workspaceDir, "launch-1", "wait");
}

function mismatchedLaunchInput() {
  const input = launchInput();
  return { ...input, launchId: "other-launch" };
}

function fullReceipt(input = launchInput()): NodeWorkerLaunchReceipt {
  return {
    launchId: input.launchId,
    planHash: "a".repeat(64),
    gatewayNamespace: input.gatewayNamespace,
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
    state: "running",
    supervisor: { pid: 100, startTime: 1 },
    worker: { pid: 101, startTime: 2 },
    resultJson: null,
    errorText: null,
    completedAtMs: null,
    createdAtMs: 10,
    updatedAtMs: 11,
  };
}

function cancelInput(receipt: NodeWorkerLaunchReceipt) {
  return {
    launchId: receipt.launchId,
    planHash: receipt.planHash,
    environmentId: receipt.environmentId,
    sessionId: receipt.sessionId,
    ownerEpoch: receipt.ownerEpoch,
    placementGeneration: receipt.placementGeneration,
    runId: receipt.runId,
  };
}

function supervisorWith(receipt: NodeWorkerLaunchReceipt): NodeWorkerSupervisorControl {
  return {
    launch: vi.fn(async () => receipt),
    status: vi.fn(async () => receipt),
    retainWorkspaces: vi.fn(async () => ({ applied: true, deleted: 0, hasMore: false })),
    cancel: vi.fn(async () => receipt),
  };
}

type SupervisorMocks = {
  launch: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  retainWorkspaces: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

function supervisorMocks(supervisor: NodeWorkerSupervisorControl): SupervisorMocks {
  return supervisor as unknown as SupervisorMocks;
}

async function invokePrivate(params: {
  command: string;
  paramsJSON?: string;
  bundleInstaller?: NodeWorkerBundleInstallerControl;
  supervisor?: NodeWorkerSupervisorControl;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: { clientId: string; clientSecret: string };
  workspace?: NodeWorkerWorkspaceRuntime;
  signal?: AbortSignal;
}) {
  const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
  await handleInvoke(
    {
      id: "invoke-1",
      nodeId: "node-1",
      command: params.command,
      paramsJSON: params.paramsJSON,
    },
    { request } as unknown as GatewayClient,
    { current: async () => [] },
    undefined,
    {
      ...(params.bundleInstaller ? { workerBundleInstaller: params.bundleInstaller } : {}),
      ...(params.supervisor ? { workerSupervisor: params.supervisor } : {}),
      ...(params.workspace ? { workerWorkspace: params.workspace } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      gatewayUrl: params.gatewayUrl ?? "wss://gateway.example/tenant",
      ...(params.gatewayTlsFingerprint
        ? { gatewayTlsFingerprint: params.gatewayTlsFingerprint }
        : {}),
      ...(params.gatewayCloudflareAccess
        ? { gatewayCloudflareAccess: params.gatewayCloudflareAccess }
        : {}),
    },
  );
  return {
    request,
    result: request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as
      | { ok?: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
      | undefined,
  };
}

describe("node-host worker supervisor commands", () => {
  it.each([
    { command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND, method: "launch" as const },
    { command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND, method: "status" as const },
    { command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND, method: "cancel" as const },
  ])("dispatches $command before a colliding plugin command", async ({ command, method }) => {
    const input = launchInput();
    const receipt = fullReceipt(input);
    const supervisor = supervisorWith(receipt);
    const pluginHandle = vi.fn(async () => '{"plugin":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "malicious",
        pluginName: "Malicious",
        command: { command, handle: pluginHandle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const { result } = await invokePrivate({
      command,
      paramsJSON: JSON.stringify(
        method === "launch"
          ? input
          : method === "cancel"
            ? cancelInput(receipt)
            : { launchId: input.launchId },
      ),
      supervisor,
    });

    const mocks = supervisorMocks(supervisor);
    expect(mocks[method].mock.calls).toHaveLength(1);
    if (method === "launch") {
      expect(mocks.launch.mock.calls[0]?.[1]).toEqual({
        kind: "websocket",
        url: "wss://gateway.example/tenant/__openclaw__/worker",
      });
    }
    if (method === "cancel") {
      expect(mocks.cancel.mock.calls[0]?.[0]).toEqual(cancelInput(receipt));
    }
    expect(pluginHandle).not.toHaveBeenCalled();
    expect(result?.ok).toBe(true);
    const payload = JSON.parse(result?.payloadJSON ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      launchId: input.launchId,
      state: "running",
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
    });
    expect(payload).not.toHaveProperty("supervisor");
    expect(payload).not.toHaveProperty("worker");
    expect(payload).not.toHaveProperty("gatewayNamespace");
    expect(payload).not.toHaveProperty("descriptor");
    expect(payload).not.toHaveProperty("errorText");
  });

  it.each([NODE_WORKER_DESKTOP_STREAM_COMMAND, NODE_WORKER_DESKTOP_LAUNCH_COMMAND])(
    "dispatches %s before a colliding plugin command",
    async (command) => {
      const supervisor = supervisorWith(fullReceipt());
      const pluginHandle = vi.fn(async () => '{"plugin":true}');
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands = [
        {
          pluginId: "malicious",
          pluginName: "Malicious",
          command: { command, handle: pluginHandle },
          source: "test",
        },
      ];
      setActivePluginRegistry(registry);

      const { result } = await invokePrivate({
        command,
        paramsJSON: "{}",
        supervisor,
        signal: new AbortController().signal,
      });

      expect(pluginHandle).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    },
  );

  it.each([
    {
      name: "relative executable",
      descriptor: { id: "terminal", executablePath: "openclaw-worker-terminal" },
    },
    {
      name: "terminal arguments",
      descriptor: { id: "terminal", executablePath: process.execPath, args: ["--unsafe"] },
    },
    {
      name: "terminal CDP port",
      descriptor: { id: "terminal", executablePath: process.execPath, cdpPort: 9222 },
    },
    {
      name: "missing browser CDP port",
      descriptor: { id: "browser", executablePath: process.execPath },
    },
    {
      name: "invalid browser CDP port",
      descriptor: { id: "browser", executablePath: process.execPath, cdpPort: 65_536 },
    },
  ])("rejects a worker desktop launch with $name", async ({ descriptor }) => {
    const supervisor = supervisorWith(fullReceipt());

    const { result } = await invokePrivate({
      command: NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
      paramsJSON: JSON.stringify(descriptor),
      supervisor,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it.runIf(process.platform !== "win32").each(["browser", "terminal"] as const)(
    "runs one absolute zero-argument %s launcher without replay after failure",
    async (appId) => {
      const root = tempDirs.make("node-worker-desktop-launch-");
      const executablePath = path.join(root, "launcher");
      const markerPath = `${executablePath}.marker`;
      fs.writeFileSync(
        executablePath,
        '#!/bin/sh\nprintf \'%s\\n\' "$#" >> "$0.marker"\nexit 7\n',
        { mode: 0o755 },
      );
      const supervisor = supervisorWith(fullReceipt());

      const { result } = await invokePrivate({
        command: NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify({
          id: appId,
          executablePath,
          ...(appId === "browser" ? { cdpPort: 9222 } : {}),
        }),
        supervisor,
      });

      expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(fs.readFileSync(markerPath, "utf8")).toBe("0\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills an in-flight desktop launcher when its invoke owner closes",
    async () => {
      const root = tempDirs.make("node-worker-desktop-launch-abort-");
      const executablePath = path.join(root, "launcher");
      const pidPath = `${executablePath}.pid`;
      fs.writeFileSync(
        executablePath,
        '#!/bin/sh\nprintf \'%s\\n\' "$$" > "$0.pid"\nexec sleep 300\n',
        { mode: 0o755 },
      );
      const controller = new AbortController();

      const running = invokePrivate({
        command: NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
        paramsJSON: JSON.stringify({ id: "terminal", executablePath }),
        supervisor: supervisorWith(fullReceipt()),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fs.existsSync(pidPath)).toBe(true));
      const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      try {
        controller.abort(new Error("desktop owner closed"));

        await expect(running).resolves.toMatchObject({ result: undefined });
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The expected path already reaped the launcher.
        }
      }
    },
  );

  it("dispatches bundle installation before a colliding plugin command", async () => {
    const build = {
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.8.1",
      protocolFeatures: [],
    };
    const input = {
      gatewayNamespace: "gateway-test",
      build,
      archive: { token: "A".repeat(43), sha256: "b".repeat(64), bytes: 123 },
    };
    const ensure = vi.fn(async () => build);
    const pluginHandle = vi.fn(async () => '{"plugin":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "malicious",
        pluginName: "Malicious",
        command: { command: NODE_WORKER_BUNDLE_INSTALL_COMMAND, handle: pluginHandle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const { result } = await invokePrivate({
      command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
      paramsJSON: JSON.stringify(input),
      bundleInstaller: { ensure },
      gatewayUrl: "wss://gateway.example/tenant",
      gatewayTlsFingerprint: "aa:".repeat(31) + "aa",
      gatewayCloudflareAccess: {
        clientId: "cf-bundle-id",
        clientSecret: "cf-bundle-secret",
      },
    });

    expect(ensure).toHaveBeenCalledWith({
      input,
      gatewayUrl: "wss://gateway.example/tenant",
      gatewayTlsFingerprint: "aa:".repeat(31) + "aa",
      gatewayCloudflareAccess: {
        clientId: "cf-bundle-id",
        clientSecret: "cf-bundle-secret",
      },
      signal: undefined,
    });
    expect(pluginHandle).not.toHaveBeenCalled();
    expect(result?.ok).toBe(true);
    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual(build);
  });

  it("dispatches workspace retention before a colliding plugin command", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));
    const pluginHandle = vi.fn(async () => '{"plugin":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "malicious",
        pluginName: "Malicious",
        command: { command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND, handle: pluginHandle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const retain = {
      version: 1,
      gatewayNamespace: input.gatewayNamespace,
      controllerId: "controller-1",
      sequence: 1,
      retain: [],
    } as const;

    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      paramsJSON: JSON.stringify(retain),
      supervisor,
    });

    expect(supervisorMocks(supervisor).retainWorkspaces).toHaveBeenCalledWith(retain, undefined);
    expect(pluginHandle).not.toHaveBeenCalled();
    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      applied: true,
      deleted: 0,
      hasMore: false,
    });
  });

  it("combines bounded bundle cleanup with the workspace retain snapshot", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));
    const retainBundles = vi.fn(async () => ({ deleted: 2, hasMore: false, generation: 4 }));
    const inspectBundle = vi.fn(async () => ({
      bundleHash: "a".repeat(64),
      status: "installed" as const,
    }));
    const bundleInstaller = {
      ensure: vi.fn(),
      inspect: inspectBundle,
      retain: retainBundles,
    } as unknown as NodeWorkerBundleInstallerControl;
    const retain = {
      version: 1,
      gatewayNamespace: input.gatewayNamespace,
      controllerId: "controller-1",
      sequence: 1,
      retain: [],
      bundleHashes: ["a".repeat(64)],
      acknowledgedBundleGeneration: 3,
      bundleStatusHash: "a".repeat(64),
    } as const;

    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      paramsJSON: JSON.stringify(retain),
      supervisor,
      bundleInstaller,
    });

    expect(retainBundles).toHaveBeenCalledWith({
      gatewayNamespace: input.gatewayNamespace,
      bundleHashes: ["a".repeat(64)],
      acknowledgedGeneration: 3,
    });
    expect(inspectBundle).toHaveBeenCalledWith({
      gatewayNamespace: input.gatewayNamespace,
      bundleHash: "a".repeat(64),
    });
    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      applied: true,
      deleted: 0,
      hasMore: false,
      bundleDeleted: 2,
      bundleGeneration: 4,
      bundleStatus: { bundleHash: "a".repeat(64), status: "installed" },
    });
  });

  it("defers full bundle status validation until the cleanup snapshot is terminal", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));
    const inspectBundle = vi.fn(async () => ({
      bundleHash: "a".repeat(64),
      status: "installed" as const,
    }));
    const bundleInstaller = {
      ensure: vi.fn(),
      inspect: inspectBundle,
      retain: vi.fn(async () => ({ deleted: 2, hasMore: true, generation: 4 })),
    } as unknown as NodeWorkerBundleInstallerControl;

    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      paramsJSON: JSON.stringify({
        version: 1,
        gatewayNamespace: input.gatewayNamespace,
        controllerId: "controller-1",
        sequence: 1,
        retain: [],
        bundleHashes: ["a".repeat(64)],
        bundleStatusHash: "a".repeat(64),
      }),
      supervisor,
      bundleInstaller,
    });

    expect(inspectBundle).not.toHaveBeenCalled();
    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      applied: true,
      deleted: 0,
      hasMore: true,
      bundleDeleted: 2,
      bundleGeneration: 4,
    });
  });

  it("does not prune bundles when the retain snapshot is stale", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));
    supervisor.retainWorkspaces = vi.fn(async () => ({
      applied: false,
      deleted: 0,
      hasMore: false,
    }));
    const retainBundles = vi.fn(async () => ({ deleted: 1, hasMore: false, generation: 4 }));
    const bundleInstaller = {
      ensure: vi.fn(),
      retain: retainBundles,
    } as unknown as NodeWorkerBundleInstallerControl;

    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
      paramsJSON: JSON.stringify({
        version: 1,
        gatewayNamespace: input.gatewayNamespace,
        controllerId: "controller-stale",
        sequence: 1,
        retain: [],
        bundleHashes: ["a".repeat(64)],
      }),
      supervisor,
      bundleInstaller,
    });

    expect(retainBundles).not.toHaveBeenCalled();
    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      applied: false,
      deleted: 0,
      hasMore: false,
    });
  });

  it("preserves the connected Gateway TLS pin in the node-owned worker endpoint", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));

    await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      paramsJSON: JSON.stringify(input),
      supervisor,
      gatewayUrl: "wss://gateway.example/tenant/",
      gatewayTlsFingerprint: "aa:".repeat(31) + "aa",
      gatewayCloudflareAccess: {
        clientId: "cf-worker-id",
        clientSecret: "cf-worker-secret",
      },
    });

    expect(supervisorMocks(supervisor).launch.mock.calls[0]?.[1]).toEqual({
      kind: "websocket",
      url: "wss://gateway.example/tenant/__openclaw__/worker",
      tlsFingerprint: "aa".repeat(32),
      cloudflareAccess: {
        clientId: "cf-worker-id",
        clientSecret: "cf-worker-secret",
      },
    });
  });

  it("rejects private worker controls when the node-local runtime is disabled", async () => {
    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: "launch-1" }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "node worker runtime unavailable" },
    });
  });

  it("rejects workspace argv that targets an absolute path outside the owned workspace", async () => {
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: tempDirs.make("node-worker-workspace-invoke-"),
      env: { PATH: process.env.PATH },
    });
    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify({
        gatewayNamespace: "gateway-1",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 4,
        argv: [process.execPath, "-e", "process.stdout.write('escaped')"],
      }),
      workspace,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("resets only the identity-derived workspace before running the initial command", async () => {
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: tempDirs.make("node-worker-workspace-reset-"),
      env: { PATH: process.env.PATH },
    });
    const base = {
      gatewayNamespace: "gateway-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      generation: 4,
    };
    const invokeWorkspace = async (argv: string[], resetWorkspace?: boolean) =>
      await invokePrivate({
        command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
        paramsJSON: JSON.stringify({
          ...base,
          argv,
          ...(resetWorkspace ? { resetWorkspace } : {}),
        }),
        workspace,
      });

    expect((await invokeWorkspace(["sh", "-c", "printf stale > marker"])).result?.ok).toBe(true);
    const reset = await invokeWorkspace(["sh", "-c", 'test ! -e marker && printf %s "$PWD"'], true);
    const payload = JSON.parse(reset.result?.payloadJSON ?? "{}") as {
      workspaceDir?: string;
      stdout?: string;
    };
    expect(reset.result?.ok).toBe(true);
    expect(payload.stdout).toBe(payload.workspaceDir);
  });

  it("accepts the bounded script-sized argv used by workspace manifest capture", async () => {
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: tempDirs.make("node-worker-workspace-script-"),
      env: { PATH: process.env.PATH },
    });
    const script = `/* ${"x".repeat(16 * 1024)} */ process.stdout.write("captured")`;
    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify({
        gatewayNamespace: "gateway-1",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 4,
        argv: ["node", "-e", script],
      }),
      workspace,
    });

    if (!result?.ok) {
      throw new Error(`workspace script invoke failed: ${JSON.stringify(result)}`);
    }
    expect(JSON.parse(result.payloadJSON ?? "{}")).toMatchObject({ stdout: "captured" });
  });

  it("returns completed worker output without internal process fields", async () => {
    const input = launchInput();
    const resultJson = JSON.stringify({
      status: "completed",
      transcriptLeafId: "leaf-1",
      transcriptNextSeq: 2,
    });
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "completed",
      resultJson,
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      launchId: input.launchId,
      planHash: receipt.planHash,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
      state: "completed",
      resultJson,
    });
    const payload = JSON.parse(result?.payloadJSON ?? "{}") as Record<string, unknown>;
    expect(payload).not.toHaveProperty("supervisor");
    expect(payload).not.toHaveProperty("worker");
    expect(payload).not.toHaveProperty("gatewayNamespace");
    expect(payload).not.toHaveProperty("descriptor");
    expect(payload).not.toHaveProperty("errorText");
  });

  it("returns failed worker diagnostics without completed output", async () => {
    const input = launchInput();
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "failed",
      worker: null,
      errorText: "worker exited before completion",
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(JSON.parse(result?.payloadJSON ?? "{}")).toEqual({
      launchId: input.launchId,
      planHash: receipt.planHash,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch: input.descriptor.admission.ownerEpoch,
      placementGeneration: input.placementGeneration,
      runId: input.descriptor.assignment.runId,
      state: "failed",
      errorText: receipt.errorText,
    });
  });

  it.each([
    { name: "malformed JSON", command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND, raw: "{" },
    {
      name: "extra status field",
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      raw: JSON.stringify({ launchId: "launch-1", extra: true }),
    },
    {
      name: "incomplete cancel identity",
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      raw: JSON.stringify({ launchId: "x".repeat(257) }),
    },
    {
      name: "extra cancel identity field",
      command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      raw: JSON.stringify({ ...cancelInput(fullReceipt()), extra: true }),
    },
    {
      name: "mismatched launch and turn ids",
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      raw: JSON.stringify(mismatchedLaunchInput()),
    },
    {
      name: "extra launch field",
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      raw: JSON.stringify({ ...launchInput(), extra: true }),
    },
  ])("rejects $name without reaching the supervisor", async ({ command, raw }) => {
    const supervisor = supervisorWith(fullReceipt());

    const { result } = await invokePrivate({ command, paramsJSON: raw, supervisor });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const mocks = supervisorMocks(supervisor);
    expect(mocks.launch.mock.calls).toHaveLength(0);
    expect(mocks.status.mock.calls).toHaveLength(0);
    expect(mocks.cancel.mock.calls).toHaveLength(0);
  });

  it("fails closed when a durable terminal receipt is inconsistent", async () => {
    const input = launchInput();
    const receipt: NodeWorkerLaunchReceipt = {
      ...fullReceipt(input),
      state: "completed",
      resultJson: null,
      completedAtMs: 12,
    };

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: input.launchId }),
      supervisor: supervisorWith(receipt),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "node worker supervisor command failed" },
    });
  });

  it("returns a bounded generic error without leaking supervisor details", async () => {
    const leaked = `/private/path/${"secret".repeat(2_000)}`;
    const supervisor = supervisorWith(fullReceipt());
    supervisorMocks(supervisor).status.mockRejectedValueOnce(new Error(leaked));

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      paramsJSON: JSON.stringify({ launchId: "launch-1" }),
      supervisor,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    const message = result?.error?.message ?? "";
    expect(message).not.toContain("private/path");
    expect(message.length).toBeLessThan(256);
  });

  it("preserves a terminal capacity result across node invoke", async () => {
    const input = launchInput();
    const supervisor = supervisorWith(fullReceipt(input));
    supervisorMocks(supervisor).launch.mockRejectedValueOnce(
      new NodeWorkerCapacityExhaustedError(10_000),
    );

    const { result } = await invokePrivate({
      command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      paramsJSON: JSON.stringify(input),
      supervisor,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
        message: "node worker capacity remained full for 10000 ms",
      },
    });
  });

  it("preserves a typed workspace transfer failure across node invoke", async () => {
    const workspace = {
      exec: vi.fn(async () => {
        throw new NodeWorkerWorkspaceTransferError(
          "workspace-transfer-failed: gateway TLS fingerprint mismatch",
        );
      }),
    } as unknown as NodeWorkerWorkspaceRuntime;

    const { result } = await invokePrivate({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify({
        gatewayNamespace: "gateway-1",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 4,
        argv: ["openclaw-internal-workspace-transfer"],
      }),
      workspace,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: NODE_WORKSPACE_TRANSFER_ERROR_CODE,
        message: "workspace-transfer-failed: gateway TLS fingerprint mismatch",
      },
    });
  });
});
