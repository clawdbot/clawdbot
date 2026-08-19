// Default status imports must not pull in the broad plugin diagnostics/runtime graph.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("status cold imports", () => {
  afterEach(() => {
    vi.doUnmock("../plugins/status.js");
    vi.resetModules();
  });

  it("keeps broad plugin status code behind the detailed status boundary", async () => {
    vi.doMock("../plugins/status.js", () => {
      throw new Error("default status must not import broad plugin diagnostics");
    });

    const [scan, textRuntime] = await Promise.all([
      import("./status.scan.js"),
      import("./status.command.text-runtime.js"),
    ]);

    expect(scan.scanStatus).toBeTypeOf("function");
    expect(textRuntime.formatPluginCompatibilityNotice).toBeTypeOf("function");
  });
});
