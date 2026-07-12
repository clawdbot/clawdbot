import { describe, expect, it } from "vitest";
import { resolveApprovalDocumentMode } from "./approval-deep-link.ts";

describe("resolveApprovalDocumentMode", () => {
  it("resolves root and configured-base approval links", () => {
    expect(resolveApprovalDocumentMode("/approve/exec%3A123", "")).toEqual({
      kind: "approval",
      approvalId: "exec:123",
    });
    expect(resolveApprovalDocumentMode("/operator/approve/plugin%3A456", "/operator/")).toEqual({
      kind: "approval",
      approvalId: "plugin:456",
    });
  });

  it("decodes one stable path segment without narrowing valid approval ids", () => {
    const approvalId = "plugin:a/b%🦞";
    expect(resolveApprovalDocumentMode(`/approve/${encodeURIComponent(approvalId)}`, "")).toEqual({
      kind: "approval",
      approvalId,
    });
  });

  it.each([
    "/approve",
    "/approve/",
    "/approve/%",
    "/approve/%2e",
    "/approve/%2E%2E",
    "/approve/id/extra",
    "/approve/id/",
  ])("keeps malformed approval-shaped paths shellless: %s", (pathname) => {
    expect(resolveApprovalDocumentMode(pathname, "")).toEqual({
      kind: "approval",
      approvalId: null,
    });
  });

  it("does not claim ordinary or out-of-mount paths", () => {
    expect(resolveApprovalDocumentMode("/chat", "")).toBeNull();
    expect(resolveApprovalDocumentMode("/approve/id", "/operator")).toBeNull();
    expect(resolveApprovalDocumentMode("/operator/approvals/id", "/operator")).toBeNull();
  });
});
