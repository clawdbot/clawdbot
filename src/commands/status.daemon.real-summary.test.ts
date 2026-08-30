// Status daemon real-summary tests cover the shared service-state path for node services.
import { expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { formatStatusServiceValue } from "./status-all/format.js";

const mocks = vi.hoisted(() => ({
  resolveNodeService: vi.fn(),
}));

vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: mocks.resolveNodeService,
}));

const { getNodeDaemonStatusSummary } = await import("./status.daemon.js");

it("renders root-status recovery guidance for a rejected node runtime", async () => {
  mocks.resolveNodeService.mockReturnValue(
    createMockGatewayService({
      label: "systemd user",
      loadedText: "enabled",
      notLoadedText: "disabled",
      readRuntime: vi.fn(async () => {
        throw new Error("node service manager unavailable");
      }),
    }),
  );

  const summary = await getNodeDaemonStatusSummary();

  expect(summary.runtime).toEqual({
    status: "unknown",
    detail: "service runtime inspection failed; retry with openclaw status --deep",
    inspectionFailure: {
      code: "service-runtime-inspection-failed",
      detail: "node service manager unavailable",
    },
  });
  expect(formatStatusServiceValue(summary)).toBe(
    "systemd user disabled (inspection failed: service runtime inspection failed; retry with openclaw status --deep) · unknown",
  );
});

it("preserves legitimate node runtime detail", async () => {
  mocks.resolveNodeService.mockReturnValue(
    createMockGatewayService({
      readRuntime: vi.fn(async () => ({
        status: "unknown",
        detail: "node process state is inconclusive",
      })),
    }),
  );

  const summary = await getNodeDaemonStatusSummary();

  expect(summary.runtime?.detail).toBe("node process state is inconclusive");
  expect(summary.runtimeShort).toBe("unknown (node process state is inconclusive)");
});
