// Remote skill runtime tests cover remote refresh and session snapshot flows.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { getSkillsSnapshotVersion, resetSkillsRefreshForTest } from "./refresh.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  refreshRemoteBinsForConnectedNodes,
  refreshRemoteNodeBins,
  setSkillsRemoteRegistry,
} from "./remote.js";

function createRemoteSkillWorkspace(bin: string): { cfg: OpenClawConfig; workspaceDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-remote-skills-"));
  const skillDir = path.join(workspaceDir, "skills", "remote-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: remote-skill",
      "description: Needs a remote bin",
      `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
      "---",
      "# Remote Skill",
      "",
    ].join("\n"),
  );
  return {
    workspaceDir,
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } satisfies OpenClawConfig,
  };
}

function recordRemoteMacWithSystemWhich(nodeId: string): void {
  recordRemoteNodeInfo({
    nodeId,
    displayName: "Remote Mac",
    platform: "darwin",
    commands: ["system.run", "system.which"],
  });
}

describe("skills-remote", () => {
  afterEach(() => {
    setSkillsRemoteRegistry(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(removeRemoteNodeInfo(nodeId)).toBeUndefined();
    expect(removeRemoteNodeInfo(nodeId)).toBeUndefined();
  });

  it("bumps the skills snapshot version when an eligible remote node disconnects", async () => {
    await resetSkillsRefreshForTest();
    const workspaceDir = `/tmp/ws-${randomUUID()}`;
    const nodeId = `node-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });

    const before = getSkillsSnapshotVersion(workspaceDir);
    removeRemoteNodeInfo(nodeId);
    const after = getSkillsSnapshotVersion(workspaceDir);

    expect(after).toBeGreaterThan(before);
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin]);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin]);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        platform: "macOS",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility();
      expect(eligibility?.platforms).toEqual(["darwin"]);
      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
      expect(eligibility?.note).toContain("Mac Studio");
      expect(eligibility?.note).toContain(nodeB);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });

  it("suppresses the exec host=node note when routing is not allowed", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeId, [bin]);

      const eligibility = getRemoteSkillEligibility({ advertiseExecNode: false });

      expect(eligibility?.hasBin(bin)).toBe(true);
      expect(eligibility?.note).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });

  it("does not expose bins for nodes that only have cached paired metadata", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeBins(nodeId, [bin]);

      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });

  it("clears stale bins when a connected node probe times out", async () => {
    await resetSkillsRefreshForTest();
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    try {
      const invokeCalls: string[] = [];
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "node invoke timed out" },
          };
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);
      recordRemoteNodeBins(nodeId, [bin]);
      const before = getSkillsSnapshotVersion(workspaceDir);

      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });

      expect(invokeCalls).toEqual(["system.which"]);
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips remote bin probes when the node connectivity preflight fails", async () => {
    await resetSkillsRefreshForTest();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-remote-skills-"));
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      fs.mkdirSync(path.join(workspaceDir, "remote-skill"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "remote-skill", "SKILL.md"),
        [
          "---",
          "name: remote-skill",
          "description: Needs a remote bin",
          `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
          "---",
          "# Remote Skill",
          "",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      } satisfies OpenClawConfig;
      const invokeCalls: string[] = [];
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        checkConnectivity: async () => ({
          ok: false,
          error: { code: "TIMEOUT", message: "node connectivity probe timed out" },
        }),
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ bins: [bin] }),
          };
        },
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });
      recordRemoteNodeBins(nodeId, [bin]);
      const before = getSkillsSnapshotVersion(workspaceDir);

      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });

      expect(invokeCalls).toEqual([]);
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries the bin probe when the node reconnects during preflight", async () => {
    await resetSkillsRefreshForTest();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-remote-skills-"));
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      fs.mkdirSync(path.join(workspaceDir, "remote-skill"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "remote-skill", "SKILL.md"),
        [
          "---",
          "name: remote-skill",
          "description: Needs a remote bin",
          `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
          "---",
          "# Remote Skill",
          "",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      } satisfies OpenClawConfig;
      let connId = "conn-old";
      const connectivityCalls: string[] = [];
      const invokeCalls: string[] = [];
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () =>
          ({
            nodeId,
            connId,
            platform: "darwin",
            commands: ["system.run", "system.which"],
          }) as unknown as ReturnType<NodeRegistry["get"]>,
        checkConnectivity: async () => {
          connectivityCalls.push(connId);
          if (connectivityCalls.length === 1) {
            connId = "conn-new";
            return {
              ok: false,
              error: { code: "TIMEOUT", message: "node connectivity probe timed out" },
            };
          }
          return { ok: true };
        },
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: true,
            payloadJSON: JSON.stringify({ bins: [bin] }),
          };
        },
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });

      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });

      expect(connectivityCalls).toEqual(["conn-old", "conn-new"]);
      expect(invokeCalls).toEqual(["system.which"]);
      expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("coalesces overlapping bin probes for the same node", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-remote-skills-"));
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    let invokeCount = 0;
    let releaseProbe: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        invoke: async () => {
          invokeCount += 1;
          resolve();
          await new Promise<void>((release) => {
            releaseProbe = release;
          });
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "node invoke timed out" },
          };
        },
      } as unknown as NodeRegistry);
    });
    try {
      fs.mkdirSync(path.join(workspaceDir, "remote-skill"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "remote-skill", "SKILL.md"),
        [
          "---",
          "name: remote-skill",
          "description: Needs a remote bin",
          `metadata: { "openclaw": { "os": ["darwin"], "requires": { "bins": ["${bin}"] } } }`,
          "---",
          "# Remote Skill",
          "",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      } satisfies OpenClawConfig;
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });

      const first = refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });
      await probeStarted;
      const second = refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });
      if (!releaseProbe) {
        throw new Error("Expected remote skill probe release callback to be initialized");
      }
      releaseProbe();

      await Promise.all([first, second]);
      expect(invokeCount).toBe(1);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reuses a successful probe after reconnect and invalidates the skills snapshot", async () => {
    await resetSkillsRefreshForTest();
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let invokeCount = 0;
    try {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        invoke: async () => {
          invokeCount += 1;
          return { ok: true, payload: { bins: [bin] } };
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);
      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
      });

      removeRemoteNodeInfo(nodeId);
      recordRemoteMacWithSystemWhich(nodeId);
      const beforeRestore = getSkillsSnapshotVersion(workspaceDir);
      nowSpy.mockReturnValue(1_000_000 + 60_000);
      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
      });

      expect(invokeCount).toBe(1);
      expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(beforeRestore);

      nowSpy.mockReturnValue(1_000_000 + 30 * 60 * 1000);
      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
      });
      expect(invokeCount).toBe(2);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("backs off failures but probes immediately when required bins change", async () => {
    const nodeId = `node-${randomUUID()}`;
    const firstBin = `bin-${randomUUID()}`;
    const secondBin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(firstBin);
    const { cfg: changedCfg, workspaceDir: changedWorkspace } =
      createRemoteSkillWorkspace(secondBin);
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    let invokeCount = 0;
    try {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        invoke: async () => {
          invokeCount += 1;
          return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);
      const refresh = (config = cfg) =>
        refreshRemoteNodeBins({
          nodeId,
          platform: "darwin",
          commands: ["system.run", "system.which"],
          cfg: config,
        });

      await refresh();
      await refresh();
      expect(invokeCount).toBe(1);

      await refresh(changedCfg);
      expect(invokeCount).toBe(2);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(changedWorkspace, { recursive: true, force: true });
    }
  });

  it("waits for connect readiness before connectivity preflight and bin probing", async () => {
    vi.useFakeTimers();
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    const checkConnectivity = vi.fn(async () => ({ ok: true as const }));
    const invoke = vi.fn(async () => ({ ok: true as const, payload: { bins: [bin] } }));
    try {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        checkConnectivity,
        invoke,
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);

      const refresh = refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        readinessDelayMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(checkConnectivity).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await refresh;
      expect(checkConnectivity).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retries a failed probe after the node reconnects", async () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    let connId = "conn-old";
    let resolveFirstInvoke:
      | ((value: Awaited<ReturnType<NodeRegistry["invoke"]>>) => void)
      | undefined;
    const firstInvoke = new Promise<Awaited<ReturnType<NodeRegistry["invoke"]>>>((resolve) => {
      resolveFirstInvoke = resolve;
    });
    const invoke = vi
      .fn()
      .mockImplementationOnce(async () => await firstInvoke)
      .mockResolvedValueOnce({ ok: true as const, payload: { bins: [bin] } });
    try {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () =>
          ({
            nodeId,
            connId,
            platform: "darwin",
            commands: ["system.run", "system.which"],
          }) as unknown as ReturnType<NodeRegistry["get"]>,
        invoke,
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({
        nodeId,
        connId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });
      const refresh = () =>
        refreshRemoteNodeBins({
          nodeId,
          platform: "darwin",
          commands: ["system.run", "system.which"],
          cfg,
        });

      const failedRefresh = refresh();
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      removeRemoteNodeInfo(nodeId);
      connId = "conn-new";
      recordRemoteNodeInfo({
        nodeId,
        connId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });
      const reconnectRefresh = refresh();
      resolveFirstInvoke?.({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      await Promise.all([failedRefresh, reconnectRefresh]);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses the approved live command surface after the connect readiness delay", async () => {
    vi.useFakeTimers();
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    let commands: string[] = [];
    const invoke = vi.fn(async () => ({ ok: true as const, payload: { bins: [bin] } }));
    try {
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () =>
          ({
            nodeId,
            connId: "conn-current",
            platform: "darwin",
            commands,
          }) as unknown as ReturnType<NodeRegistry["get"]>,
        checkConnectivity: async () => ({ ok: true }),
        invoke,
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({ nodeId, platform: "darwin", commands: [] });

      const connectRefresh = refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: [],
        cfg,
        readinessDelayMs: 5_000,
      });
      commands = ["system.run", "system.which"];
      const approvalRefresh = refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands,
        cfg,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([connectRefresh, approvalRefresh]);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId, command: "system.which" }),
      );
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records bins from system.which object-map responses", async () => {
    await resetSkillsRefreshForTest();
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    try {
      const invokeCalls: string[] = [];
      setSkillsRemoteRegistry({
        listConnected: () => [],
        get: () => undefined,
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: true,
            payload: { bins: { [bin]: `/opt/homebrew/bin/${bin}`, missing: "" } },
            payloadJSON: JSON.stringify({ bins: { [bin]: `/opt/homebrew/bin/${bin}` } }),
          };
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeId);
      const before = getSkillsSnapshotVersion(workspaceDir);

      await refreshRemoteNodeBins({
        nodeId,
        platform: "darwin",
        commands: ["system.run", "system.which"],
        cfg,
        timeoutMs: 10,
      });

      expect(invokeCalls).toEqual(["system.which"]);
      expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
      expect(getRemoteSkillEligibility()?.hasBin("missing")).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
    } finally {
      removeRemoteNodeInfo(nodeId);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("continues the connected-node refresh after one node fails", async () => {
    await resetSkillsRefreshForTest();
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    const { cfg, workspaceDir } = createRemoteSkillWorkspace(bin);
    try {
      const invokeCalls: string[] = [];
      setSkillsRemoteRegistry({
        listConnected: () => [
          { nodeId: nodeA, platform: "darwin", commands: ["system.run", "system.which"] },
          { nodeId: nodeB, platform: "darwin", commands: ["system.run", "system.which"] },
        ],
        get: () => undefined,
        checkConnectivity: (nodeId: string) => {
          if (nodeId === nodeA) {
            throw new Error("simulated connectivity failure");
          }
          return { ok: true };
        },
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return { ok: true, payloadJSON: JSON.stringify({ bins: [bin] }) };
        },
      } as unknown as NodeRegistry);
      recordRemoteMacWithSystemWhich(nodeA);
      recordRemoteMacWithSystemWhich(nodeB);
      recordRemoteNodeBins(nodeA, ["stale-bin"]);

      await expect(refreshRemoteBinsForConnectedNodes(cfg)).resolves.toBeUndefined();

      expect(invokeCalls).toEqual(["system.which"]);
      expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);
      expect(getRemoteSkillEligibility()?.hasBin("stale-bin")).toBe(false);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
