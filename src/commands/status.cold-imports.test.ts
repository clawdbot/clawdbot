// Default status imports must not pull in the broad plugin diagnostics/runtime graph.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("status cold imports", () => {
  afterEach(() => {
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../agents/model-auth-label.js");
    vi.doUnmock("./status.daemon.js");
    vi.resetModules();
  });

  it("collects default runtime status without loading usage credentials", async () => {
    vi.doMock("../agents/model-auth-label.js", () => {
      throw new Error("default status must not import usage credential resolution");
    });
    vi.doMock("./status.daemon.js", () => ({
      getDaemonStatusSummary: async () => ({ label: "gateway" }),
      getNodeDaemonStatusSummary: async () => ({ label: "node" }),
    }));

    const { resolveStatusRuntimeSnapshot } = await import("./status-runtime-shared.js");

    await expect(
      resolveStatusRuntimeSnapshot({ config: {}, sourceConfig: {}, gatewayReachable: false }),
    ).resolves.toEqual({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "gateway" },
      nodeService: { label: "node" },
    });
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
