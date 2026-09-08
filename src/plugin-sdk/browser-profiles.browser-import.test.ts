import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

type BrowserProfilesModule = typeof import("./browser-profiles.js");

describe("plugin-sdk browser profiles import", () => {
  afterEach(() => {
    vi.doUnmock("../infra/tmp-openclaw-dir.js");
    vi.resetModules();
  });

  it("keeps the SDK facade independent from secure temp resolution", async () => {
    const resolvePreferredOpenClawTmpDir = vi.fn(() => {
      throw new Error("secure temp resolution must stay lazy");
    });
    const loadTempResolver = vi.fn(() => ({ resolvePreferredOpenClawTmpDir }));
    vi.doMock("../infra/tmp-openclaw-dir.js", loadTempResolver);

    const browserProfiles = await importFreshModule<BrowserProfilesModule>(
      import.meta.url,
      "./browser-profiles.js?scope=browser-safe",
    );

    expect(loadTempResolver).not.toHaveBeenCalled();
    expect(resolvePreferredOpenClawTmpDir).not.toHaveBeenCalled();
    expect(browserProfiles.DEFAULT_UPLOAD_DIR).toBe("/tmp/openclaw/uploads");
  });
});
