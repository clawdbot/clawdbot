// Covers approval turn-source route checks.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveApprovalInitiatingSurfaceStateMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./exec-approval-surface.js", () => ({
  resolveApprovalInitiatingSurfaceState: (...args: unknown[]) =>
    resolveApprovalInitiatingSurfaceStateMock(...args),
}));

import { hasApprovalTurnSourceRoute } from "./approval-turn-source.js";

describe("hasApprovalTurnSourceRoute", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveApprovalInitiatingSurfaceStateMock.mockReset();
    loadConfigMock.mockReturnValue({ loaded: true });
  });

  it("returns true when the initiating surface is enabled", () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValue({ kind: "enabled" });

    expect(
      hasApprovalTurnSourceRoute({
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
      }),
    ).toBe(true);
    expect(resolveApprovalInitiatingSurfaceStateMock).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "work",
      cfg: { loaded: true },
      approvalKind: "exec",
    });
  });

  it("passes plugin approval kind to the initiating surface check", () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValue({ kind: "disabled" });

    expect(
      hasApprovalTurnSourceRoute({
        turnSourceChannel: "whatsapp",
        turnSourceAccountId: "default",
        approvalKind: "plugin",
      }),
    ).toBe(false);
    expect(resolveApprovalInitiatingSurfaceStateMock).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "default",
      cfg: { loaded: true },
      approvalKind: "plugin",
    });
  });

  it("returns false when the initiating surface is disabled or unsupported", () => {
    resolveApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "disabled" });
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "discord" })).toBe(false);

    resolveApprovalInitiatingSurfaceStateMock.mockReturnValueOnce({ kind: "unsupported" });
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "unknown-channel" })).toBe(false);
  });

  it("returns false when there is no turn-source channel", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: undefined })).toBe(false);
    expect(resolveApprovalInitiatingSurfaceStateMock).not.toHaveBeenCalled();
  });
});
