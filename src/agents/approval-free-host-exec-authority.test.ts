import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { hasApprovalFreeHostExecAuthority } from "./approval-free-host-exec-authority.js";

const hoisted = vi.hoisted(() => ({
  file: { version: 1, defaults: { security: "full", ask: "off" } } as ExecApprovalsFile,
  loadError: undefined as Error | undefined,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  loadExecApprovals: () => {
    if (hoisted.loadError) {
      throw hoisted.loadError;
    }
    return hoisted.file;
  },
}));

describe("hasApprovalFreeHostExecAuthority", () => {
  afterEach(() => {
    hoisted.file = { version: 1, defaults: { security: "full", ask: "off" } };
    hoisted.loadError = undefined;
  });

  it.each([
    { mode: "full", security: "full", ask: "off", expected: true },
    { mode: "allowlist", security: "allowlist", ask: "off", expected: false },
    { mode: "ask", security: "allowlist", ask: "on-miss", expected: false },
  ] as const)("returns $expected for $mode/$security/$ask", ({ expected, ...config }) => {
    expect(
      hasApprovalFreeHostExecAuthority({
        ...config,
        bypassHostApprovalFloors: true,
      }),
    ).toBe(expected);
  });

  it("requires the live host approvals floor to remain full/off", () => {
    hoisted.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
    };

    expect(
      hasApprovalFreeHostExecAuthority({
        mode: "full",
        security: "full",
        ask: "off",
      }),
    ).toBe(false);
  });

  it("fails closed when the host approvals floor cannot be read", () => {
    hoisted.loadError = new Error("approval store unavailable");

    expect(
      hasApprovalFreeHostExecAuthority({
        mode: "full",
        security: "full",
        ask: "off",
      }),
    ).toBe(false);
  });
});
