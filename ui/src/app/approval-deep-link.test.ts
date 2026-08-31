// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inferBasePathFromPathname } from "../app-route-paths.ts";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";

describe("approval document routing", () => {
  it("resolves root and configured-base approval links", () => {
    expect(resolveControlUiDocumentMode("/approve/exec%3A123", "")).toEqual({
      kind: "approval",
      approvalId: "exec:123",
    });
    expect(resolveControlUiDocumentMode("/operator/approve/plugin%3A456", "/operator/")).toEqual({
      kind: "approval",
      approvalId: "plugin:456",
    });
  });

  it("decodes one stable path segment without narrowing valid approval ids", () => {
    const approvalId = "plugin:a/b%🦞";
    expect(resolveControlUiDocumentMode(`/approve/${encodeURIComponent(approvalId)}`, "")).toEqual({
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
    expect(resolveControlUiDocumentMode(pathname, "")).toEqual({
      kind: "approval",
      approvalId: null,
    });
  });

  it("does not claim ordinary or out-of-mount paths", () => {
    expect(resolveControlUiDocumentMode("/chat", "")).toBeNull();
    expect(resolveControlUiDocumentMode("/approve/id", "/operator")).toBeNull();
    expect(resolveControlUiDocumentMode("/operator/approvals/id", "/operator")).toBeNull();
  });
});

describe("question document routing", () => {
  it("resolves root and configured-base question links without changing approval routing", () => {
    expect(resolveControlUiDocumentMode("/ask/question%3A123", "")).toEqual({
      kind: "question",
      questionId: "question:123",
    });
    expect(resolveControlUiDocumentMode("/operator/ask/question%3A456", "/operator/")).toEqual({
      kind: "question",
      questionId: "question:456",
    });
    expect(resolveControlUiDocumentMode("/approve/approval%3A123", "")).toEqual({
      kind: "approval",
      approvalId: "approval:123",
    });
    expect(inferBasePathFromPathname("/ask/question%3A123")).toBe("");
    expect(inferBasePathFromPathname("/operator/ask/question%3A456")).toBe("/operator");
  });

  it.each(["/ask", "/ask/", "/ask/%", "/ask/%2e", "/ask/id/extra", "/ask/id/"])(
    "keeps malformed question-shaped paths shellless: %s",
    (pathname) => {
      expect(resolveControlUiDocumentMode(pathname, "")).toEqual({
        kind: "question",
        questionId: null,
      });
    },
  );

  it("does not claim ordinary or out-of-mount paths", () => {
    expect(resolveControlUiDocumentMode("/chat", "")).toBeNull();
    expect(resolveControlUiDocumentMode("/ask/id", "/operator")).toBeNull();
  });
});
