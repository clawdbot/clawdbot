import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillsSnapshotVersion, resetSkillsRefreshForTest } from "../agents/skills/refresh.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NodeRegistry } from "../gateway/node-registry.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  refreshRemoteNodeBins,
  setSkillsRemoteRegistry,
} from "./skills-remote.js";

describe("skills-remote", () => {
  afterEach(() => {
    setSkillsRemoteRegistry(null);
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
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "node invoke timed out" },
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

      expect(invokeCalls).toEqual(["system.which"]);
      expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
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

  it("records bins from system.which object-map responses", async () => {
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
        invoke: async (params: { command: string }) => {
          invokeCalls.push(params.command);
          return {
            ok: true,
            payload: { bins: { [bin]: `/opt/homebrew/bin/${bin}`, missing: "" } },
            payloadJSON: JSON.stringify({ bins: { [bin]: `/opt/homebrew/bin/${bin}` } }),
          };
        },
      } as unknown as NodeRegistry);
      recordRemoteNodeInfo({
        nodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.run", "system.which"],
      });
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
});
