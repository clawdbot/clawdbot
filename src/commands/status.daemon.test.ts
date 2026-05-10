import { describe, expect, it, vi } from "vitest";
import { getDaemonStatusSummary } from "./status.daemon.js";

const mocks = vi.hoisted(() => ({
  readServiceStatusSummary: vi.fn(),
  resolveGatewayService: vi.fn(() => ({ kind: "gateway" })),
  resolveNodeService: vi.fn(() => ({ kind: "node" })),
}));

vi.mock("./status.service-summary.js", () => ({
  readServiceStatusSummary: mocks.readServiceStatusSummary,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: mocks.resolveNodeService,
}));

describe("status daemon summary", () => {
  it("preserves service layout diagnostics for status output", async () => {
    mocks.readServiceStatusSummary.mockResolvedValueOnce({
      label: "systemd",
      installed: true,
      loaded: true,
      managedByOpenClaw: true,
      externallyManaged: false,
      loadedText: "enabled",
      runtime: { status: "running", pid: 1234 },
      layout: {
        execStart: "/usr/bin/node /opt/openclaw/dist/entry.js gateway",
        sourceScope: "system",
        entrypointSourceCheckout: false,
      },
    });

    const summary = await getDaemonStatusSummary();
    expect(summary.runtimeShort).toContain("running");
    expect(summary.layout?.execStart).toBe("/usr/bin/node /opt/openclaw/dist/entry.js gateway");
    expect(summary.layout?.sourceScope).toBe("system");
    expect(summary.layout?.entrypointSourceCheckout).toBe(false);
  });
});
