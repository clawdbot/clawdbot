import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";

const importCases = [
  {
    label: "reply session module",
    importPath: "../auto-reply/reply/session.js",
    scope: "reply-session",
  },
  {
    label: "session store module",
    importPath: "../config/sessions/store.js",
    scope: "session-store",
  },
] as const;

describe("session archive runtime import guards", () => {
  const archiveRuntimeLoadsByScope = new Map<string, number>();

  beforeAll(async () => {
    for (const { importPath, scope } of importCases) {
      const archiveRuntimeLoads = vi.fn();
      vi.doMock("./session-archive.runtime.js", async () => {
        archiveRuntimeLoads();
        return await vi.importActual<typeof import("./session-archive.runtime.js")>(
          "./session-archive.runtime.js",
        );
      });

      try {
        await importFreshModule<typeof import("./session-archive.runtime.js")>(
          import.meta.url,
          `${importPath}?scope=no-archive-runtime-on-import-${scope}`,
        );
        archiveRuntimeLoadsByScope.set(scope, archiveRuntimeLoads.mock.calls.length);
      } finally {
        vi.doUnmock("./session-archive.runtime.js");
      }
    }
  });

  it.each(importCases)(
    "does not load archive runtime on module import for $label",
    async ({ scope }) => {
      expect(archiveRuntimeLoadsByScope.get(scope)).toBe(0);
    },
  );
});
