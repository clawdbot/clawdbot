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
  checkpointResult,
  commandResult,
  openWarmImageStore,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

function fixture(failCreate = false, onCommand?: (argv: string[]) => void | Promise<void>) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-allocation-"));
  const calls: string[][] = [];
  let captures = 0;
  const manager = () =>
    createCrabboxWarmImageManager({
      warn: vi.fn(),
      runArgs: ({ id }) => ["run", "--id", id, "--script-stdin"],
      runCommand: async (argv) => {
        calls.push(argv);
        await onCommand?.(argv);
        if (failCreate && argv[2] === "create") {
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        if (argv[2] === "create") {
          const checkpointId = ++captures === 1 ? CHECKPOINT_ID : `chk_generation_${captures}`;
          return checkpointResult(checkpointId, argv[argv.indexOf("--id") + 1]!, "available");
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
    ...(projectKey ? { projectKey } : {}),
    timeoutMs: () => 60_000,
  });
  return { manager, context, calls };
}

describe("Crabbox durable allocation admission", () => {
  it("retains a late capture image without resurrecting its released allocation", async () => {
    const { manager, context } = fixture(false, async (argv) => {
      if (argv[2] === "create") {
        await owner.release(project);
      }
    });
    const owner = manager();
    const project = {
      ...context("cbx_source", "project-a"),
      preparation: {
        key: "a".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session" as const,
        demandAtMs: Date.now(),
      },
    };
    await owner.allocate(project);
    owner.markPrepared(project.id, "b".repeat(40));
    await expect(owner.capture(project)).resolves.toBe(true);
    resetPluginStateStoreForTests();
    expect(manager().lookupLease(project.id)).toBeUndefined();
    expect(openWarmImageStore().entries()[0]?.value).toMatchObject({
      allocations: {},
      image: { checkpointId: CHECKPOINT_ID, preparationKey: project.preparation.key },
    });
    expect(openWarmImageStore().entries()[0]?.value.operation).toBeUndefined();
  });

  it("freezes preparation and demand before allocation and refreshes only the consumed image generation", async () => {
    const { manager, context, calls } = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const preparation = {
      key: "1".repeat(64),
      cacheKey: "c".repeat(64),
      purpose: "session" as const,
      demandAtMs: now,
    };
    const source = { ...context("cbx_source", "project-a"), preparation };
    const owner = manager();
    await owner.allocate(source);
    owner.markPrepared(source.id, "a".repeat(40));
    await owner.capture(source);
    owner.markEnrolled(source.id);
    expect(openWarmImageStore().entries()[0]?.value.image).toMatchObject({
      preparationKey: preparation.key,
      lastDemandAtMs: now,
    });

    clock.mockReturnValue(now + 60_000);
    const reserve = {
      ...source,
      id: "cbx_reserve",
      slug: "cbx_reserve",
      preparation: { ...preparation, purpose: "reserve" as const },
    };
    await owner.allocate(reserve);
    expect(owner.lookupLease(reserve.id)).toMatchObject({
      preparationKey: preparation.key,
      demandAtMs: now,
      imageGeneration: { checkpointId: CHECKPOINT_ID, createdAtMs: now },
    });
    expect(openWarmImageStore().entries()[0]?.value.image?.lastDemandAtMs).toBe(now);
    resetPluginStateStoreForTests();
    const restarted = manager();
    await restarted.allocate(reserve);
    expect(openWarmImageStore().entries()[0]?.value.image?.lastDemandAtMs).toBe(now);
    restarted.notePreparedDemand(reserve.id, {
      preparationKey: preparation.key,
      demandAtMs: now + 60_000,
    });
    restarted.notePreparedDemand(source.id, { preparationKey: preparation.key, demandAtMs: now });
    expect(openWarmImageStore().entries()[0]?.value.image?.lastDemandAtMs).toBe(now + 60_000);

    calls.length = 0;
    for (const changed of [
      { ...reserve.preparation, demandAtMs: now + 1 },
      { ...reserve.preparation, cacheKey: "d".repeat(64) },
      { ...reserve.preparation, purpose: "session" as const },
    ]) {
      await expect(restarted.allocate({ ...reserve, preparation: changed })).rejects.toThrow(
        "changed its recorded profile or project identity",
      );
    }
    expect(calls).toEqual([]);
    const next = {
      ...context("cbx_next", "project-a"),
      preparation: {
        key: "2".repeat(64),
        cacheKey: preparation.cacheKey,
        purpose: "reserve" as const,
        demandAtMs: now + 60_000,
      },
    };
    await restarted.allocate(next);
    expect(calls.find((argv) => argv[2] === "fork")?.[3]).toBe(CHECKPOINT_ID);
    restarted.markPrepared(next.id, "b".repeat(40));
    await restarted.capture(next);
    expect(openWarmImageStore().entries()[0]?.value.image?.checkpointId).toBe("chk_generation_2");
    restarted.notePreparedDemand(reserve.id, {
      preparationKey: preparation.key,
      demandAtMs: now + 120_000,
    });
    expect(openWarmImageStore().entries()[0]?.value.image?.lastDemandAtMs).toBe(now + 60_000);
    restarted.notePreparedDemand(next.id, {
      preparationKey: next.preparation.key,
      demandAtMs: now + 120_000,
    });
    expect(openWarmImageStore().entries()[0]?.value.image?.lastDemandAtMs).toBe(now + 120_000);
    calls.length = 0;
    await restarted.allocate({
      ...next,
      id: "cbx_incompatible",
      slug: "cbx_incompatible",
      preparation: { ...next.preparation, key: "3".repeat(64), cacheKey: "d".repeat(64) },
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  });

  it("preserves old prepared demand and cleanup without treating unknown cache identity as ordinary", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const project = {
      ...context("cbx_old_prepared", "project-a"),
      preparation: {
        key: "a".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session" as const,
        demandAtMs: Date.now(),
      },
    };
    await owner.allocate(project);
    owner.markPrepared(project.id, "b".repeat(40));
    await owner.capture(project);
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    store.register(entry.key, {
      ...entry.value,
      image: { ...entry.value.image!, cacheKey: null, purpose: null },
      allocations: {
        [project.id]: { ...entry.value.allocations[project.id]!, cacheKey: null, purpose: null },
      },
    });
    calls.length = 0;
    await owner.allocate(context("cbx_ordinary", "project-a"));
    await owner.allocate({ ...project, id: "cbx_prepared", slug: "cbx_prepared" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "warmup"]);
    calls.length = 0;
    await expect(owner.capture(project)).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(store.lookup(entry.key)?.image?.lastDemandAtMs).toBe(project.preparation.demandAtMs);
    await owner.release(project);
    expect(owner.lookupLease(project.id)).toBeUndefined();
  });

  it("keeps unverified image obligations for recorded replays but never admits a new hit", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const source = context("cbx_source");
    await owner.allocate(source);
    owner.markEnrolled(source.id);
    await owner.capture(source);
    await owner.release(source);
    const replay = context("cbx_replay");
    await owner.allocate(replay);
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    store.register(entry.key, {
      ...entry.value,
      image: { ...entry.value.image!, lastDemandAtMs: null, preparationKey: null },
      allocations: {
        [replay.id]: {
          ...entry.value.allocations[replay.id]!,
          preparationKey: null,
          demandAtMs: null,
          imageGeneration: null,
        },
      },
    });
    resetPluginStateStoreForTests();
    const reopened = manager();
    calls.length = 0;
    await reopened.allocate(context("cbx_new"));
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
    await reopened.allocate(replay);
    expect(calls.at(-1)?.slice(1, 4)).toEqual(["checkpoint", "fork", CHECKPOINT_ID]);
    expect(store.lookup(entry.key)?.image?.lastDemandAtMs).toBeNull();
    await reopened.release(replay);
    await reopened.maintain(context("maintenance"));
    expect(calls.at(-1)?.slice(1)).toEqual(["checkpoint", "delete", CHECKPOINT_ID]);
    expect(store.lookup(entry.key)?.image).toBeUndefined();
    expect(reopened.lookupLease("cbx_new")?.choice).toEqual({ kind: "cold" });
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

  it("keeps a recorded capture barrier even when foreground restore policy skips capture", async () => {
    const { manager, context, calls } = fixture();
    const owner = manager();
    const project = {
      ...context("cbx_source", "project-a"),
      preparation: {
        key: "a".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session" as const,
        demandAtMs: Date.now(),
      },
    };
    await owner.allocate(project);
    owner.markPrepared(project.id, "a".repeat(40));
    await owner.capture(project);
    const foreground = { ...project, id: "cbx_foreground", slug: "cbx_foreground" };
    await owner.allocate(foreground);
    owner.markPrepared(foreground.id, "a".repeat(40));
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    store.register(entry.key, {
      ...entry.value,
      operation: {
        type: "capture",
        id: "unresolved-before-policy-change",
        leaseId: foreground.id,
        phase: "uncertain",
        startedAtMs: Date.now(),
      },
    });
    resetPluginStateStoreForTests();
    const restarted = manager();
    calls.length = 0;
    await expect(restarted.capture(foreground)).rejects.toThrow("capture is unresolved");
    expect(() => restarted.markEnrolled(foreground.id)).toThrow("capture is unresolved");
    expect(calls).toEqual([]);
    expect(store.lookup(entry.key)?.operation?.type).toBe("capture");
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
        preparationKey: null,
        cacheKey: null,
        purpose: null,
        demandAtMs: null,
        imageGeneration: null,
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
