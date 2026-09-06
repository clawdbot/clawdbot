import { Command } from "commander";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCrabboxWarmImageCommands } from "./crabbox-worker-warm-image-cli.js";
import {
  openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SELECTOR = "83eb5c1e-e408-4b64-9575-f8670287e294";
let output = "";

beforeEach(() => {
  resetPluginStateStoreForTests();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-warm-cli-"));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function pendingCapture(): WarmProfileRecord {
  const now = Date.now();
  return {
    version: 2,
    allocations: {},
    image: {
      checkpointId: "chk_last_good",
      kind: "native",
      state: "available",
      createdAtMs: now - 86_400_000,
      lastUsedAtMs: now,
    },
    operation: {
      type: "capture",
      id: SELECTOR,
      startedAtMs: now - 1_200_000,
      leaseId: "cbx_capture",
      provider: "aws",
      phase: "creating",
    },
  };
}

async function runCli(...args: string[]) {
  const program = new Command().exitOverride();
  registerCrabboxWarmImageCommands(program);
  await program.parseAsync(["crabbox", "warm-images", ...args], { from: "user" });
}

describe("Crabbox warm-image CLI", () => {
  it("recovers a legacy allocation only after acknowledgment of the exact unchanged row", async () => {
    const legacy = createPluginStateSyncKeyedStoreForTests<{ machineClass: string }>("crabbox", {
      namespace: "warm-leases",
      maxEntries: 256,
    });
    legacy.register("cbx_legacy", { machineClass: "standard" });
    await runCli("--json");
    const selector = JSON.parse(output).legacyLeases[0].selector as string;
    expect(JSON.parse(output).legacyLeases[0]).toMatchObject({
      leaseId: "cbx_legacy",
      machineClass: "standard",
    });
    await expect(runCli("--recover", selector)).rejects.toThrow("--acknowledge-provider-cleanup");
    legacy.register("cbx_legacy", { machineClass: "fast" });
    await expect(runCli("--recover", selector, "--acknowledge-provider-cleanup")).rejects.toThrow(
      "selector is absent or changed",
    );
    expect(legacy.lookup("cbx_legacy")).toEqual({ machineClass: "fast" });
    output = "";
    await runCli("--json");
    await runCli(
      "--recover",
      JSON.parse(output).legacyLeases[0].selector,
      "--acknowledge-provider-cleanup",
    );
    expect(legacy.lookup("cbx_legacy")).toBeUndefined();
  });

  it("inspects retained capture ownership after reopening SQLite without changing it", async () => {
    const record = pendingCapture();
    openCrabboxWarmImageStore().register("profile", record);
    resetPluginStateStoreForTests();

    await runCli("--json");

    expect(JSON.parse(output)).toEqual({
      legacyLeases: [],
      images: [
        {
          profileKey: "profile",
          checkpointId: "chk_last_good",
          state: "available",
          createdAtMs: record.image!.createdAtMs,
          lastUsedAtMs: record.image!.lastUsedAtMs,
          allocations: {},
          capture: {
            selector: SELECTOR,
            startedAtMs:
              record.operation?.type === "capture" ? record.operation.startedAtMs : undefined,
            leaseId: "cbx_capture",
            provider: "aws",
            phase: "creating",
            stale: true,
          },
        },
      ],
    });
    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual(record);
  });

  it.each([
    {
      name: "missing acknowledgement",
      args: ["--recover", SELECTOR],
      error: "--acknowledge-provider-cleanup",
    },
    {
      name: "changed selector",
      args: ["--recover", "stale-selector", "--acknowledge-provider-cleanup"],
      error: "selector is absent or changed",
    },
    {
      name: "missing selector",
      args: ["--acknowledge-provider-cleanup"],
      error: "requires --recover",
    },
  ])("rejects $name without clearing durable ownership", async ({ args, error }) => {
    const record = pendingCapture();
    openCrabboxWarmImageStore().register("profile", record);

    await expect(runCli(...args)).rejects.toThrow(error);

    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual(record);
  });

  it("acknowledges only the selected capture and preserves its last-good checkpoint and other retirement", async () => {
    const record = pendingCapture();
    const retiring: WarmProfileRecord = {
      ...record,
      image: { ...record.image!, checkpointId: "chk_replacement" },
      operation: { type: "retire", checkpointId: "chk_predecessor" },
    };
    openCrabboxWarmImageStore().register("profile", record);
    openCrabboxWarmImageStore().register("other", retiring);

    await runCli("--recover", SELECTOR, "--acknowledge-provider-cleanup", "--json");

    expect(JSON.parse(output).recoveredCapture).toBe(SELECTOR);
    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual({
      ...record,
      operation: undefined,
    });
    expect(openCrabboxWarmImageStore().lookup("other")).toEqual(retiring);
    const replacement = {
      ...record,
      operation: {
        type: "capture" as const,
        id: "replacement-selector",
        startedAtMs: Date.now(),
        leaseId: "cbx_replacement",
        provider: "aws",
        phase: "creating" as const,
      },
    };
    openCrabboxWarmImageStore().register("profile", replacement);
    await expect(runCli("--recover", SELECTOR, "--acknowledge-provider-cleanup")).rejects.toThrow(
      "selector is absent or changed",
    );
    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual(replacement);
  });

  it("prints the exact manual recovery command and pending checkpoint deletion", async () => {
    const record = pendingCapture();
    openCrabboxWarmImageStore().register("profile", record);
    openCrabboxWarmImageStore().register("retiring", {
      ...record,
      operation: { type: "retire", checkpointId: "chk_predecessor" },
    });

    await runCli();

    expect(output).toContain(
      `openclaw crabbox warm-images --recover ${SELECTOR} --acknowledge-provider-cleanup`,
    );
    expect(output).toContain("Stop the owning Gateway and capture processes");
    expect(output).toContain("Checkpoint deletion pending: chk_predecessor");
  });
});
