// Status JSON cold-import tests guard the default route from optional memory runtime imports.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("status.scan.fast-json cold imports", () => {
  afterEach(() => {
    vi.doUnmock("../agents/memory-search.js");
    vi.doUnmock("./status.scan-memory.js");
    vi.resetModules();
  });

  it("keeps optional memory runtime modules cold at command import time", async () => {
    vi.resetModules();
    vi.doMock("../agents/memory-search.js", () => {
      throw new Error("default status JSON must not import the memory search runtime");
    });
    vi.doMock("./status.scan-memory.js", () => {
      throw new Error("default status JSON must not import the optional memory scan");
    });

    const module = await import("./status.scan.fast-json.js");

    expect(module.scanStatusJsonFast).toBeTypeOf("function");
  });
});
