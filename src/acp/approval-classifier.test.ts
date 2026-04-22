import { describe, expect, it } from "vitest";
import { classifyAcpToolApproval } from "./approval-classifier.js";

function classify(params: {
  title: string;
  rawInput?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  cwd?: string;
}) {
  return classifyAcpToolApproval({
    cwd: params.cwd ?? "/workspace",
    toolCall: {
      title: params.title,
      rawInput: params.rawInput,
      _meta: params.meta,
    },
  });
}

describe("classifyAcpToolApproval", () => {
  it("auto-approves scoped readonly reads", () => {
    expect(
      classify({
        title: "read: src/index.ts",
        rawInput: { path: "src/index.ts" },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "readonly_scoped",
      autoApprove: true,
    });
  });

  it("does not auto-approve reads outside cwd", () => {
    expect(
      classify({
        title: "read: ~/.ssh/id_rsa",
        rawInput: { path: "~/.ssh/id_rsa" },
      }),
    ).toEqual({
      toolName: "read",
      approvalClass: "other",
      autoApprove: false,
    });
  });

  it("auto-approves readonly search tools", () => {
    expect(
      classify({
        title: "memory_search: vectors",
        rawInput: { name: "memory_search", query: "vectors" },
      }),
    ).toEqual({
      toolName: "memory_search",
      approvalClass: "readonly_search",
      autoApprove: true,
    });
  });

  it("classifies process as exec-capable even for readonly-like actions", () => {
    expect(
      classify({
        title: "process: list",
        rawInput: { name: "process", action: "list" },
      }),
    ).toEqual({
      toolName: "process",
      approvalClass: "exec_capable",
      autoApprove: false,
    });
  });

  it.each([
    {
      title: "cron: status",
      rawInput: { name: "cron", action: "status" },
      expectedToolName: "cron",
      expectedClass: "control_plane",
    },
    {
      title: "nodes: list",
      rawInput: { name: "nodes", action: "list" },
      expectedToolName: "nodes",
      expectedClass: "exec_capable",
    },
  ] as const)(
    "classifies shared owner-only ACP backstops for $expectedToolName",
    ({ title, rawInput, expectedToolName, expectedClass }) => {
      expect(
        classify({
          title,
          rawInput,
        }),
      ).toEqual({
        toolName: expectedToolName,
        approvalClass: expectedClass,
        autoApprove: false,
      });
    },
  );

  it("classifies gateway as control-plane", () => {
    expect(
      classify({
        title: "gateway: status",
        rawInput: { name: "gateway", action: "status" },
      }),
    ).toEqual({
      toolName: "gateway",
      approvalClass: "control_plane",
      autoApprove: false,
    });
  });

  it("classifies mutating messaging tools as mutating", () => {
    expect(
      classify({
        title: "message: send",
        rawInput: { name: "message", action: "send", message: "hi" },
      }),
    ).toEqual({
      toolName: "message",
      approvalClass: "mutating",
      autoApprove: false,
    });
  });

  it("fails closed on spoofed metadata and title mismatches", () => {
    expect(
      classify({
        title: "exec: uname -a",
        rawInput: { name: "search", query: "uname -a" },
      }),
    ).toEqual({
      toolName: undefined,
      approvalClass: "unknown",
      autoApprove: false,
    });
  });
});
