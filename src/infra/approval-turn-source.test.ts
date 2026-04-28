import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveExecApprovalInitiatingSurfaceStateMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./exec-approval-surface.js", () => ({
  resolveExecApprovalInitiatingSurfaceState: (...args: unknown[]) =>
    resolveExecApprovalInitiatingSurfaceStateMock(...args),
}));

import { hasApprovalTurnSourceRoute } from "./approval-turn-source.js";

describe("hasApprovalTurnSourceRoute", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveExecApprovalInitiatingSurfaceStateMock.mockReset();
    loadConfigMock.mockReturnValue({ loaded: true });
  });

  it("returns true when the initiating surface is enabled", () => {
    resolveExecApprovalInitiatingSurfaceStateMock.mockReturnValue({ kind: "enabled" });

    expect(
      hasApprovalTurnSourceRoute({
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
      }),
    ).toBe(true);
    expect(resolveExecApprovalInitiatingSurfaceStateMock).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "work",
      cfg: { loaded: true },
    });
  });

  it("returns false when the initiating surface is disabled or unsupported", () => {
    resolveExecApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "disabled" });
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "discord" })).toBe(false);

    resolveExecApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "unsupported" });
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "unknown-channel" })).toBe(false);
  });

  it("returns false when there is no turn-source channel", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: undefined })).toBe(false);
    expect(resolveExecApprovalInitiatingSurfaceStateMock).not.toHaveBeenCalled();
  });
});
