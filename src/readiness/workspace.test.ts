import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceReadinessCondition,
  createWorkspaceReadinessEvidenceResolver,
} from "./workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("buildWorkspaceReadinessCondition", () => {
  it("is advisory until an operator or profile promotes the criterion", () => {
    expect(
      buildWorkspaceReadinessCondition({
        writable: false,
        reason: "WorkspaceStorageFull",
        message: "Workspace storage is full.",
      }),
    ).toMatchObject({
      type: "WorkspaceWritable",
      status: "False",
      requirement: "advisory",
      reason: "WorkspaceStorageFull",
    });
  });

  it("reports unavailable evidence without synthesizing success", () => {
    expect(buildWorkspaceReadinessCondition()).toMatchObject({
      type: "WorkspaceWritable",
      status: "Unknown",
      requirement: "advisory",
      reason: "WorkspaceNotChecked",
    });
  });
});

describe("probeWorkspaceWritable", () => {
  it("writes, flushes, and removes its probe file", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-ready-"));
    tempDirs.push(workspaceDir);

    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({ cacheTtlMs: 0 });
    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: workspaceDir } } } }),
    ).resolves.toMatchObject({
      writable: true,
      reason: "WorkspaceWritable",
    });
    await expect(readdir(workspaceDir)).resolves.toEqual([]);
  });

  it("reports a missing workspace without creating it", async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-missing-"));
    tempDirs.push(parentDir);
    const workspaceDir = path.join(parentDir, "workspace");

    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({ cacheTtlMs: 0 });
    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: workspaceDir } } } }),
    ).resolves.toMatchObject({
      writable: false,
      reason: "WorkspaceMissing",
    });
    await expect(access(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["ENOSPC", "WorkspaceStorageFull"],
    ["EROFS", "WorkspaceNotWritable"],
    ["ENOENT", "WorkspaceMissing"],
  ])("uses the stable reason for %s", async (code, reason) => {
    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({
      cacheTtlMs: 0,
      probe: async () => {
        throw Object.assign(new Error("probe failure"), { code });
      },
    });
    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: "/workspace" } } } }),
    ).resolves.toMatchObject({ writable: false, reason });
  });
});

describe("createWorkspaceReadinessEvidenceResolver", () => {
  it("caches and coalesces probes for the effective default workspace", async () => {
    let releaseProbe:
      | ((value: { writable: true; reason: string; message: string }) => void)
      | undefined;
    const probe = vi.fn(
      () =>
        new Promise<{ writable: true; reason: string; message: string }>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    let now = 100;
    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({
      cacheTtlMs: 50,
      probeTimeoutMs: 1_000,
      probe,
      now: () => now,
    });
    const config = { agents: { defaults: { workspace: "/workspace" } } };
    const first = resolveEvidence({ config });
    const second = resolveEvidence({ config });

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    releaseProbe?.({ writable: true, reason: "WorkspaceWritable", message: "ready" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { writable: true, reason: "WorkspaceWritable", message: "ready" },
      { writable: true, reason: "WorkspaceWritable", message: "ready" },
    ]);
    await resolveEvidence({ config });
    expect(probe).toHaveBeenCalledTimes(1);

    now += 51;
    void resolveEvidence({ config });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });

  it("fails closed on a timed-out probe without starting duplicate I/O", async () => {
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({
      cacheTtlMs: 0,
      probeTimeoutMs: 5,
      probe,
    });
    const config = { agents: { defaults: { workspace: "/workspace" } } };

    await expect(resolveEvidence({ config })).resolves.toMatchObject({
      writable: null,
      reason: "WorkspaceProbeTimedOut",
    });
    await expect(resolveEvidence({ config })).resolves.toMatchObject({
      writable: null,
      reason: "WorkspaceProbeTimedOut",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not publish evidence from a retired config snapshot", async () => {
    const releaseProbes: Array<
      (value: { writable: true; reason: string; message: string }) => void
    > = [];
    const probe = vi.fn(
      () =>
        new Promise<{ writable: true; reason: string; message: string }>((resolve) => {
          releaseProbes.push(resolve);
        }),
    );
    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({
      probe,
      probeTimeoutMs: 500,
    });
    const firstConfig = { agents: { defaults: { workspace: "/workspace" } } };
    const nextConfig = { agents: { defaults: { workspace: "/workspace" } } };
    const first = resolveEvidence({ config: firstConfig });
    const next = resolveEvidence({ config: nextConfig });

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    releaseProbes[0]?.({ writable: true, reason: "WorkspaceWritable", message: "retired" });
    releaseProbes[1]?.({ writable: true, reason: "WorkspaceWritable", message: "ready" });
    await expect(first).resolves.toMatchObject({ reason: "WorkspaceNotChecked" });
    await expect(next).resolves.toMatchObject({ reason: "WorkspaceWritable" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("bounds detached probes across repeated workspace generations", async () => {
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const resolveEvidence = createWorkspaceReadinessEvidenceResolver({
      cacheTtlMs: 0,
      probeTimeoutMs: 5,
      probe,
    });

    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: "/workspace-a" } } } }),
    ).resolves.toMatchObject({ reason: "WorkspaceProbeTimedOut" });
    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: "/workspace-b" } } } }),
    ).resolves.toMatchObject({ reason: "WorkspaceProbeTimedOut" });
    await expect(
      resolveEvidence({ config: { agents: { defaults: { workspace: "/workspace-c" } } } }),
    ).resolves.toMatchObject({ reason: "WorkspaceProbeTimedOut" });

    expect(probe).toHaveBeenCalledTimes(2);
  });
});
