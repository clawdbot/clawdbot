import { Command } from "commander";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCrabboxWarmImageCommands } from "./crabbox-worker-warm-image-cli.js";
import {
  openCrabboxWarmImageStore,
  type WarmImageRecord,
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

function pendingCapture(): WarmImageRecord {
  const now = Date.now();
  return {
    checkpointId: "chk_last_good",
    kind: "native",
    state: "available",
    createdAtMs: now - 86_400_000,
    lastUsedAtMs: now,
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
  it("inspects retained capture ownership after reopening SQLite without changing it", async () => {
    const record = pendingCapture();
    openCrabboxWarmImageStore().register("profile", record);
    resetPluginStateStoreForTests();

    await runCli("--json");

    expect(JSON.parse(output)).toEqual({
      images: [
        {
          profileKey: "profile",
          checkpointId: "chk_last_good",
          state: "available",
          createdAtMs: record.createdAtMs,
          lastUsedAtMs: record.lastUsedAtMs,
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
    const retiring: WarmImageRecord = {
      ...record,
      checkpointId: "chk_replacement",
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
