import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import {
  WARM_IMAGE_MAX_ALLOCATIONS,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import {
  CHECKPOINT_ID,
  PROFILE,
  NODE_RUNTIME_IDENTITY,
  checkpointResult,
  commandResult,
  openWarmImageStore,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

function fixture(failCreate = false, onCommand?: (argv: string[]) => void) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-allocation-"));
  const calls: string[][] = [];
  let captures = 0;
  const manager = () =>
    createCrabboxWarmImageManager({
      warn: vi.fn(),
      runArgs: ({ id }) => ["run", "--id", id, "--script-stdin"],
      runCommand: async (argv) => {
        calls.push(argv);
        onCommand?.(argv);
        if (failCreate && argv[2] === "create") {
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        if (argv[2] === "create") {
          captures += 1;
          return checkpointResult(
            captures === 1 ? CHECKPOINT_ID : `${CHECKPOINT_ID}_${captures}`,
            argv[argv.indexOf("--id") + 1]!,
            "available",
          );
        }
        if (argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "metadata_available",
              providerState: "available",
              nextAction: "fork_or_delete",
            }),
          });
        }
        if (argv[2] === "fork") {
          return commandResult({
            stdout: JSON.stringify({
              checkpointId: argv[3],
              leaseId: argv[argv.indexOf("--lease-id") + 1],
              slug: argv[argv.indexOf("--slug") + 1],
              provider: "aws",
              workdir: "/workspace",
            }),
          });
        }
        return commandResult();
      },
    });
  const context = (id: string, projectKey?: string) => ({
    binary: "crabbox",
    id,
    provider: "aws",
    slug: id,
    profile: resolveCrabboxProvisionProfile(PROFILE, undefined).profile,
    nodeRuntimeIdentity: NODE_RUNTIME_IDENTITY,
    ...(projectKey ? { projectKey } : {}),
    timeoutMs: () => 60_000,
  });
  return { manager, context, calls };
}

describe("Crabbox durable allocation admission", () => {
  it.each([
    { nodeBootstrapSha256: "b".repeat(64) },
    { executionMode: "remote-exec" as const },
    { workerBundleSha256: "c".repeat(64) },
  ])(
    "refreshes changed runtime content without letting an older cold allocation replace it: %j",
    async (change) => {
      const { manager, context, calls } = fixture();
      const owner = manager();
      const initial = context("cbx_initial");
      const older = context("cbx_older");
      await owner.allocate(initial);
      await owner.allocate(older);
      owner.markEnrolled(initial.id);
      owner.markEnrolled(older.id);
      await owner.capture(initial);
      await owner.release(initial);
      const newer = {
        ...context("cbx_newer"),
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, ...change },
      };
      expect(await owner.allocate(newer)).toEqual({
        kind: "checkpoint",
        checkpointId: CHECKPOINT_ID,
      });
      owner.markEnrolled(newer.id);
      expect(await owner.capture(newer)).toBe(true);
      await owner.release(newer);
      const published = structuredClone(openWarmImageStore().entries()[0]!.value);
      expect(published.image?.runtimeIdentity).toEqual(newer.nodeRuntimeIdentity);
      expect(published.operation).toBeUndefined();
      calls.length = 0;
      expect(await owner.capture(older)).toBe(false);
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]!.value.image).toEqual(published.image);
      await owner.release(older);
      expect(openWarmImageStore().entries()).toHaveLength(1);
    },
  );

  it.each(["pending", "enrolled"] as const)(
    "preserves %s replay choices when runtime identity is missing or changes",
    async (phase) => {
      const { manager, context, calls } = fixture();
      const owner = manager();
      const original = context("cbx_original");
      await owner.allocate(original);
      if (phase === "enrolled") {
        owner.markEnrolled(original.id);
      }
      const recorded = structuredClone(openWarmImageStore().entries()[0]!);
      const changed = {
        ...original,
        nodeRuntimeIdentity: { ...NODE_RUNTIME_IDENTITY, nodeBootstrapSha256: "d".repeat(64) },
      };
      calls.length = 0;
      await expect(manager().allocate(changed)).rejects.toThrow("recorded node runtime identity");
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]).toEqual(recorded);
      delete recorded.value.allocations[original.id]!.runtimeIdentity;
      openWarmImageStore().register(recorded.key, recorded.value);
      const legacyRecorded = structuredClone(openWarmImageStore().entries()[0]!);
      resetPluginStateStoreForTests();
      const restarted = manager();
      await expect(restarted.allocate(original)).rejects.toThrow("recorded node runtime identity");
      expect(await restarted.capture(original)).toBe(false);
      expect(calls).toEqual([]);
      expect(openWarmImageStore().entries()[0]).toEqual(legacyRecorded);
      await restarted.release(original);
      expect(openWarmImageStore().entries()).toEqual([]);
    },
  );

  it("uses an image without runtime metadata as a base but refreshes its unproven content", async () => {
    const { manager, context } = fixture();
    const owner = manager();
    const original = context("cbx_original");
    await owner.allocate(original);
    owner.markEnrolled(original.id);
    await owner.capture(original);
    await owner.release(original);
    const legacy = openWarmImageStore().entries()[0]!;
    delete legacy.value.image!.runtimeIdentity;
    openWarmImageStore().register(legacy.key, legacy.value);
    const next = context("cbx_next");
    expect(await owner.allocate(next)).toEqual({ kind: "checkpoint", checkpointId: CHECKPOINT_ID });
    owner.markEnrolled(next.id);
    expect(await owner.capture(next)).toBe(true);
    expect(openWarmImageStore().entries()[0]!.value.image?.runtimeIdentity).toEqual(
      NODE_RUNTIME_IDENTITY,
    );
    await owner.release(next);
    expect(openWarmImageStore().entries()).toHaveLength(1);
  });

  it("does not begin a native capture after project authority closes during scrub", async () => {
    let active = true;
    const { manager, context, calls } = fixture(false, (argv) => {
      if (argv[1] === "run") {
        active = false;
      }
    });
    const owner = manager();
    const project = {
      ...context("cbx_project", "project-a"),
      assertCurrent: () => {
        if (!active) {
          throw new Error("project authority closed");
        }
      },
    };
    await owner.allocate(project);
    owner.markPrepared(project.id, "a".repeat(40));
    await expect(owner.capture(project)).rejects.toThrow("project authority closed");
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    expect(openWarmImageStore().entries()[0]?.value.operation).toBeUndefined();
    expect(owner.lookupLease(project.id)?.phase).toBe("prepared");
  });

  it("keeps an uncertain project capture fenced before enrollment after restart", async () => {
    const { manager, context, calls } = fixture(true);
    const owner = manager();
    const project = context("cbx_project", "project-a");
    await owner.allocate(project);
    owner.markPrepared(project.id, "a".repeat(40));
    await expect(owner.capture(project)).rejects.toThrow("capture is unresolved");
    expect(openWarmImageStore().entries()[0]?.value.operation).toMatchObject({
      type: "capture",
      leaseId: project.id,
      phase: "uncertain",
    });
    resetPluginStateStoreForTests();
    const restarted = manager();
    calls.length = 0;
    await expect(restarted.capture(project)).rejects.toThrow("capture is unresolved");
    expect(calls).toEqual([]);
    expect(() => restarted.markEnrolled(project.id)).toThrow("capture is unresolved");
    await restarted.release(project);
    expect(restarted.lookupLease(project.id)).toBeUndefined();
    expect(openWarmImageStore().entries()[0]?.value.operation?.type).toBe("capture");
  });

  it("refuses a full profile before allocation while allowing an existing cold replay", async () => {
    const { manager, context, calls } = fixture();
    const initial = manager();
    await initial.allocate(context("cbx_existing"));
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    const allocations: WarmProfileRecord["allocations"] = { ...entry.value.allocations };
    for (let index = 1; index < WARM_IMAGE_MAX_ALLOCATIONS; index++) {
      allocations[`cbx_pending_${index}`] = {
        choice: { kind: "cold" },
        machineClass: "standard",
        phase: "pending",
      };
    }
    store.register(entry.key, { ...entry.value, allocations });
    resetPluginStateStoreForTests();
    const reopened = manager();
    calls.length = 0;
    await expect(reopened.allocate(context("cbx_rejected"))).rejects.toThrow("capacity is full");
    expect(calls).toEqual([]);
    await reopened.allocate(context("cbx_existing"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    await reopened.release(context("cbx_existing"));
    calls.length = 0;
    await reopened.allocate(context("cbx_rejected"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    expect(reopened.lookupLease("cbx_rejected")?.choice).toEqual({ kind: "cold" });
  });

  it("captures a verified prepared project once and never captures its enrolled session", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const project = context("cbx_first", "project-a");
    await owner.allocate(project);
    await owner.capture(project);
    expect(calls.some((argv) => argv[2] === "create")).toBe(false);
    owner.markPrepared(project.id, "a".repeat(40));
    await owner.capture(project);
    const image = openWarmImageStore().entries()[0]?.value.image;
    expect(image).toMatchObject({ checkpointId: CHECKPOINT_ID, baseCommit: "a".repeat(40) });
    owner.markEnrolled(project.id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    calls.length = 0;
    await owner.capture(project);
    expect(calls.some((argv) => argv[1] === "run" || argv[2] === "create")).toBe(false);
    await owner.release(project);
    resetPluginStateStoreForTests();
    const restarted = manager();
    await restarted.allocate(context("cbx_next", "project-a"));
    expect(calls.find((argv) => argv[2] === "fork")?.[3]).toBe(CHECKPOINT_ID);
    calls.length = 0;
    await restarted.allocate(context("cbx_other", "project-b"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    expect(restarted.lookupLease("cbx_next")).toMatchObject({
      projectKey: "project-a",
      machineClass: "standard",
      phase: "pending",
    });
  });
});
