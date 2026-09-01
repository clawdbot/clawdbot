// Default status imports must not pull in the broad plugin diagnostics/runtime graph.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("status cold imports", () => {
  afterEach(() => {
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../agents/model-auth-label.js");
    vi.doUnmock("./status.daemon.js");
    vi.resetModules();
  });

  it("isolates failed usage imports from default runtime status", async () => {
    const usageImportFailure = new Error("usage credential resolution failed to load");
    vi.doMock("../agents/model-auth-label.js", () => {
      throw usageImportFailure;
    });
    vi.doMock("./status.daemon.js", () => ({
      getDaemonStatusSummary: async () => ({ label: "gateway" }),
      getNodeDaemonStatusSummary: async () => ({ label: "node" }),
    }));

    const { resolveStatusRuntimeSnapshot } = await import("./status-runtime-shared.js");
    const params = { config: {}, sourceConfig: {}, gatewayReachable: false };
    const snapshot = await resolveStatusRuntimeSnapshot(params);

    expect(snapshot).toEqual({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "gateway" },
      nodeService: { label: "node" },
    });

    // Usage collection must preserve its failure without breaking pure text formatting.
    await expect(resolveStatusRuntimeSnapshot({ ...params, usage: true })).rejects.toMatchObject({
      cause: usageImportFailure,
    });
    const { formatUsageReportLines } = await import("./status.command.text-runtime.js");
    expect(formatUsageReportLines({ updatedAt: 0, providers: [] })).toEqual([
      "Usage: no provider usage available.",
    ]);
    await expect(resolveStatusRuntimeSnapshot(params)).resolves.toEqual(snapshot);
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
