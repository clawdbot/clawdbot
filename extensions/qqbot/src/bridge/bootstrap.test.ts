// Qqbot tests cover the built-in platform adapter boundary.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformAdapter } from "../engine/adapter/index.js";
import { ensurePlatformAdapter } from "./bootstrap.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

const canonicalLoserResult = {
  applied: false,
  approval: {
    id: "exec:looks-like-exec/1",
    urlPath: "/approve/exec%3Alooks-like-exec%2F1",
    createdAtMs: 1,
    expiresAtMs: 10_000,
    presentation: {
      kind: "plugin",
      title: "Plugin approval",
      description: "Approve a plugin operation",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    },
    status: "denied",
    decision: "deny",
    resolvedAtMs: 2,
    reason: "user",
  },
} satisfies ApprovalResolveResult;

describe("QQBot built-in platform adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ channels: { qqbot: {} } });
    mocks.resolveApprovalOverGateway.mockResolvedValue(canonicalLoserResult);
    ensurePlatformAdapter();
  });

  it("preserves plugin ownership and the canonical first-answer result", async () => {
    const adapter = getPlatformAdapter();

    const result = await adapter.resolveApproval?.({
      approvalId: "exec:looks-like-exec/1",
      approvalKind: "plugin",
      decision: "allow-once",
    });

    expect(mocks.resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: { channels: { qqbot: {} } },
      approvalId: "exec:looks-like-exec/1",
      approvalKind: "plugin",
      decision: "allow-once",
      clientDisplayName: "QQBot Approval Handler",
    });
    expect(result).toBe(canonicalLoserResult);
  });
});
