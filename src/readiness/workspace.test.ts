import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceReadinessCondition,
  createWorkspaceReadinessEvidenceResolver,
  probeWorkspaceWritable,
  workspaceProbeFailure,
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

    await expect(probeWorkspaceWritable(workspaceDir)).resolves.toMatchObject({
      writable: true,
      reason: "WorkspaceWritable",
    });
    await expect(readdir(workspaceDir)).resolves.toEqual([]);
  });

  it("reports a missing workspace without creating it", async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-missing-"));
    tempDirs.push(parentDir);
    const workspaceDir = path.join(parentDir, "workspace");

    await expect(probeWorkspaceWritable(workspaceDir)).resolves.toMatchObject({
      writable: false,
      reason: "WorkspaceMissing",
    });
    await expect(access(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses stable reasons for full and read-only storage", () => {
    expect(
      workspaceProbeFailure(Object.assign(new Error("full"), { code: "ENOSPC" })),
    ).toMatchObject({ writable: false, reason: "WorkspaceStorageFull" });
    expect(
      workspaceProbeFailure(Object.assign(new Error("read only"), { code: "EROFS" })),
    ).toMatchObject({ writable: false, reason: "WorkspaceNotWritable" });
    expect(
      workspaceProbeFailure(Object.assign(new Error("missing"), { code: "ENOENT" })),
    ).toMatchObject({ writable: false, reason: "WorkspaceMissing" });
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
});
