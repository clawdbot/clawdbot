import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("plugin state permission hardening", () => {
  it("does not reject a committed write when post-commit chmod fails", async () => {
    let chmodCalls = 0;
    let throwAfter = Number.POSITIVE_INFINITY;

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        chmodSync: (target: Parameters<typeof actual.chmodSync>[0], mode: number) => {
          chmodCalls += 1;
          if (chmodCalls > throwAfter) {
            throw Object.assign(new Error("chmod denied"), { code: "EACCES" });
          }
          return actual.chmodSync(target, mode);
        },
        existsSync: (target: Parameters<typeof actual.existsSync>[0]) => {
          const pathname = String(target);
          if (pathname.endsWith("-shm") || pathname.endsWith("-wal")) {
            return false;
          }
          return actual.existsSync(target);
        },
      };
    });

    const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
      await import("./plugin-state-store.js");

    try {
      await withOpenClawTestState({ label: "plugin-state-post-commit-chmod" }, async () => {
        const store = createPluginStateKeyedStore<{ value: number }>("fixture-plugin", {
          namespace: "post-commit",
          maxEntries: 10,
        });
        await store.register("first", { value: 1 });

        chmodCalls = 0;
        throwAfter = 2;

        await expect(store.register("second", { value: 2 })).resolves.toBeUndefined();
        await expect(store.lookup("second")).resolves.toEqual({ value: 2 });
      });
    } finally {
      resetPluginStateStoreForTests();
    }
  });
});
