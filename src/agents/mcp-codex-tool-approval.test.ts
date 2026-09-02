import { describe, expect, it } from "vitest";
import {
  formatMcpCodexApprovalRemedy,
  normalizeMcpCodexToolAnnotations,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "./mcp-codex-tool-approval.js";

describe("Codex MCP tool approval projection", () => {
  it.each([
    { kind: "oversized", serverName: "a".repeat(129) },
    { kind: "option-shaped", serverName: "--help" },
  ])("keeps $kind server names out of executable approval hints", ({ serverName }) => {
    expect(formatMcpCodexApprovalRemedy(serverName)).toContain(
      "openclaw mcp configure <server> --approval approve",
    );
  });

  it("keeps native projection optional while scheduled enforcement defaults to auto", () => {
    const server = { command: "example-mcp" };
    expect(resolveProjectedMcpCodexToolApprovalMode("example", server)).toBeUndefined();
    expect(requiresMcpCodexToolApproval({ mode: undefined })).toBe(true);
  });

  it("preserves explicit modes and the loopback OpenClaw approval exception", () => {
    expect(
      resolveProjectedMcpCodexToolApprovalMode("example", {
        command: "example-mcp",
        codex: { defaultToolsApprovalMode: "prompt" },
      }),
    ).toBe("prompt");
    expect(
      resolveProjectedMcpCodexToolApprovalMode("openclaw", {
        url: "http://127.0.0.1:18789/mcp",
      }),
    ).toBe("approve");
  });

  it.each([
    { mode: "approve" as const, annotations: {}, expected: false },
    { mode: "prompt" as const, annotations: { readOnlyHint: true }, expected: true },
    { mode: "auto" as const, annotations: { destructiveHint: true }, expected: true },
    { mode: "auto" as const, annotations: { readOnlyHint: true }, expected: false },
    {
      mode: "auto" as const,
      annotations: { destructiveHint: false, openWorldHint: false },
      expected: false,
    },
    { mode: "auto" as const, annotations: { destructiveHint: false }, expected: true },
    { mode: "auto" as const, annotations: {}, expected: true },
  ])("resolves $mode with $annotations", ({ mode, annotations, expected }) => {
    expect(requiresMcpCodexToolApproval({ mode, annotations })).toBe(expected);
  });

  it("copies only boolean MCP annotations", () => {
    expect(
      normalizeMcpCodexToolAnnotations({
        readOnlyHint: true,
        destructiveHint: "false",
        idempotentHint: false,
        extra: true,
      }),
    ).toEqual({ readOnlyHint: true, idempotentHint: false });
  });

  it.each([
    { mode: undefined, fullPermission: true, expected: false },
    { mode: undefined, fullPermission: false, expected: true },
    { mode: "auto" as const, fullPermission: true, expected: true },
    { mode: "prompt" as const, fullPermission: true, expected: true },
    { mode: "approve" as const, fullPermission: false, expected: false },
  ])("honors $mode with full permission $fullPermission", ({ expected, ...policy }) => {
    expect(requiresMcpCodexToolApproval(policy)).toBe(expected);
  });
});
