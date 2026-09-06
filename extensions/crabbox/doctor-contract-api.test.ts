import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  crabboxLegacyWarmImageCaptureSelector,
  listCrabboxLegacyWarmLeases,
  openCrabboxWarmImageStore,
} from "./src/crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const migration = stateMigrations[0]!;
const image = {
  checkpointId: "chk_retained",
  kind: "machine0-image",
  state: "available",
  createdAtMs: 10,
  lastUsedAtMs: 20,
};
let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  resetPluginStateStoreForTests();
  stateDir = tempDirs.make("openclaw-crabbox-migration-");
  env = { OPENCLAW_STATE_DIR: stateDir };
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
});

function openStore<T>(options: OpenKeyedStoreOptions) {
  return createPluginStateKeyedStoreForTests<T>("crabbox", { ...options, env });
}

function legacyImages() {
  return openStore<unknown>({
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}

function input(
  context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore: openStore },
) {
  return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "credentials"), context };
}

describe("Crabbox warm-profile Doctor migration", () => {
  it.each<{ name: string; record: typeof image & { operation?: unknown } }>([
    { name: "available image", record: image },
    {
      name: "in-flight capture",
      record: {
        ...image,
        operation: {
          type: "capture",
          id: "capture-owned",
          startedAtMs: 30,
          leaseId: "cbx_owned",
          provider: "machine0",
          phase: "creating",
        },
      },
    },
    {
      name: "pending retirement",
      record: { ...image, operation: { type: "retire", checkpointId: "chk_previous" } },
    },
  ])(
    "preserves $name across SQLite reopen without fabricating an allocation",
    async ({ record }) => {
      await legacyImages().register("profile", record);
      expect(() => openCrabboxWarmImageStore(env).lookup("profile")).toThrow("doctor --fix");
      const before = await legacyImages().lookup("profile");
      expect(await migration.detectLegacyState(input())).not.toBeNull();
      expect(await legacyImages().lookup("profile")).toEqual(before);

      const result = await migration.migrateLegacyState(input());
      expect(result.warnings).toEqual([]);
      resetPluginStateStoreForTests();
      const { operation, ...metadata } = record;
      expect(openCrabboxWarmImageStore(env).lookup("profile")).toEqual({
        version: 2,
        image: metadata,
        allocations: {},
        ...(operation ? { operation } : {}),
      });
      expect(await migration.detectLegacyState(input())).toBeNull();
      expect(await migration.migrateLegacyState(input())).toEqual({ changes: [], warnings: [] });
    },
  );

  it("preserves the recovery selector of an ownerless legacy capture", async () => {
    const reserved = { ...image, checkpointId: "", kind: "", state: "pending" };
    await legacyImages().register("reserved", reserved);
    const selector = crabboxLegacyWarmImageCaptureSelector("reserved", reserved);

    await migration.migrateLegacyState(input());
    resetPluginStateStoreForTests();

    expect(openCrabboxWarmImageStore(env).lookup("reserved")).toEqual({
      version: 2,
      allocations: {},
      operation: {
        type: "capture",
        id: selector,
        startedAtMs: image.createdAtMs,
        phase: "uncertain",
      },
    });
  });

  it("reports every unresolved legacy lease with executable acknowledged recovery and keeps its row", async () => {
    const store = openStore<{ machineClass: string }>({
      namespace: "warm-leases",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
    });
    await store.register("cbx_legacy", { machineClass: "tiny" });
    const [lease] = listCrabboxLegacyWarmLeases(env);
    const command = `openclaw crabbox warm-images --recover ${lease!.selector} --acknowledge-provider-cleanup`;

    expect((await migration.detectLegacyState(input()))?.preview.join("\n")).toContain(command);
    const result = await migration.migrateLegacyState(input());
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("1 legacy Crabbox lease row(s)");
    expect(result.warnings.join("\n")).toContain(command);
    expect(result.warnings.join("\n")).toContain("stop the original Gateway/capture processes");
    expect(await store.lookup("cbx_legacy")).toEqual({ machineClass: "tiny" });
  });

  it("leaves unsupported records and future versions untouched", async () => {
    const rows = [
      { ...image, operation: { type: "capture", checkpointId: "unknown-paid-artifact" } },
      { ...image, unrecognizedCleanupObligation: "preserve" },
      { version: 3, allocations: {} },
    ];
    const store = legacyImages();
    for (const [index, row] of rows.entries()) {
      await store.register(String(index), row);
    }

    const result = await migration.migrateLegacyState(input());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(rows.length);
    expect(
      Object.fromEntries((await store.entries()).map(({ key, value }) => [key, value])),
    ).toEqual(Object.fromEntries(rows.map((row, index) => [String(index), row])));
  });

  it.each(["changed", "write-failed"])(
    "preserves paid ownership when publication is %s",
    async (failure) => {
      const store = legacyImages();
      await store.register("profile", image);
      const newer = { ...image, operation: { type: "retire", checkpointId: "chk_new_obligation" } };
      const update = store.update!.bind(store);
      vi.spyOn(store, "update").mockImplementationOnce(async (key, callback, options) => {
        if (failure === "write-failed") {
          throw new Error("write unavailable");
        }
        await store.register(key, newer);
        return update(key, callback, options);
      });
      const context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore: openStore };
      vi.spyOn(context, "openPluginStateKeyedStore").mockReturnValue(store);

      const result = await migration.migrateLegacyState(input(context));

      expect(result.changes).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(await store.lookup("profile")).toEqual(failure === "changed" ? newer : image);
    },
  );
});
