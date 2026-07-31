/**
 * Lazy gateway server entrypoint tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTrace = process.env.OPENCLAW_GATEWAY_STARTUP_TRACE;

describe("gateway server boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalTrace === undefined) {
      delete process.env.OPENCLAW_GATEWAY_STARTUP_TRACE;
    } else {
      process.env.OPENCLAW_GATEWAY_STARTUP_TRACE = originalTrace;
    }
  });

  it("lazy-loads server.impl on demand", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const mod = await import("./server.js");
    expect(stderrWrite).not.toHaveBeenCalledWith(
      expect.stringContaining("gateway.server-impl-import"),
    );

    await mod.resetPreparedModelCatalogForTest();

    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("gateway.server-impl-import"));
  });
});
