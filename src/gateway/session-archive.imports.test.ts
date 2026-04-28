import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";

describe("session archive runtime import guards", () => {
  it.each([
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
  ])("does not load archive runtime on module import for $label", async ({ importPath, scope }) => {
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
      expect(archiveRuntimeLoads).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./session-archive.runtime.js");
    }
  });
});
