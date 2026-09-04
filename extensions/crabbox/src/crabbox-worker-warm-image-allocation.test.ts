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

function fixture(failCreate = false, onCommand?: (argv: string[]) => void) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-allocation-"));
  const calls: string[][] = [];
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
          return checkpointResult(CHECKPOINT_ID, argv[argv.indexOf("--id") + 1]!, "available");
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
