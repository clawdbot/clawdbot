// Gateway Protocol tests cover exec approvals validators behavior.
import { describe, expect, it } from "vitest";
import {
  validateExecApprovalRequestParams,
  validateExecApprovalsNodeSnapshot,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "./index.js";

/**
 * Exec approval validator regressions for gateway and node-scoped policy
 * writes. The fixtures pin runtime-owned allowlist metadata and command-span
 * bounds because those contracts are consumed by approval UI and replay logic.
 */

describe("exec approvals protocol validators", () => {
  it("accepts runtime-owned allowlist metadata on gateway and node set payloads", () => {
    const file = {
      version: 1 as const,
      agents: {
        main: {
          allowlist: [
            {
              id: "entry-1",
              pattern: "cmd:allow-always:abcdef",
              source: "allow-always" as const,
              commandText: "python3 -c 'print(123)'",
              argPattern: "-c *",
              // The Mac App records Date.timeIntervalSince1970, which retains
              // sub-millisecond precision when converted to milliseconds.
              lastUsedAt: 1775154056736.5,
              lastUsedCommand: "python3 -c 'print(123)'",
              lastResolvedPath: "/usr/bin/python3",
            },
          ],
        },
      },
    };

    expect(validateExecApprovalsSetParams({ file, baseHash: "abc123" })).toBe(true);
    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "node-1",
        file,
        baseHash: "abc123",
      }),
    ).toBe(true);
  });

  it("accepts the shipped Windows node approval contract", () => {
    expect(
      validateExecApprovalsNodeSnapshot({
        enabled: true,
        hash: "sha256:current",
        baseHash: "sha256:current",
        defaultAction: "deny",
        constraints: {
          baseHashRequired: true,
          defaultAllowAllowed: false,
          broadAllowRulesAllowed: false,
          dangerousAllowRulesAllowed: false,
        },
        rules: [{ pattern: "hostname", action: "allow", enabled: true }],
      }),
    ).toBe(true);
    expect(
      validateExecApprovalsNodeSnapshot({ enabled: false, message: "No exec policy configured" }),
    ).toBe(true);
    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "windows-node",
        native: { defaultAction: "deny", rules: [] },
        baseHash: "sha256:current",
      }),
    ).toBe(true);
  });

  it("rejects ambiguous or unsafe host-native approval payloads", () => {
    for (const snapshot of [
      {},
      { hash: "sha256:current" },
      { enabled: true, hash: "sha256:current", defaultAction: "deny" },
      { enabled: true, hash: "sha256:current", defaultAction: "full", rules: [] },
      {
        path: "/tmp/exec-approvals.json",
        exists: true,
        hash: "sha256:file",
        file: { version: 1 },
        defaultAction: "deny",
      },
      {
        enabled: true,
        hash: "sha256:current",
        defaultAction: "deny",
        rules: [],
        message: "mixed state",
      },
      { enabled: false, rules: [] },
    ]) {
      expect(validateExecApprovalsNodeSnapshot(snapshot)).toBe(false);
    }

    for (const params of [
      { nodeId: "windows-node", native: {}, baseHash: "sha256:current" },
      {
        nodeId: "windows-node",
        native: { defaultAction: "deny" },
        baseHash: "sha256:current",
      },
      { nodeId: "windows-node", native: { defaultAction: "full" }, baseHash: "sha256:current" },
      { nodeId: "windows-node", native: { rules: [] } },
      {
        nodeId: "windows-node",
        native: { rules: [{ pattern: "", action: "allow" }] },
        baseHash: "sha256:current",
      },
    ]) {
      expect(validateExecApprovalsNodeSetParams(params)).toBe(false);
    }
  });

  it("rejects unknown allowlist metadata", () => {
    expect(
      validateExecApprovalsSetParams({
        file: {
          version: 1,
          agents: {
            main: {
              allowlist: [
                {
                  pattern: "/usr/bin/python3",
                  source: "unknown-source",
                },
              ],
            },
          },
        },
        baseHash: "abc123",
      }),
    ).toBe(false);

    expect(
      validateExecApprovalsSetParams({
        file: {
          version: 1,
          agents: {
            main: {
              allowlist: [
                {
                  pattern: "/usr/bin/python3",
                  randomMetadata: true,
                },
              ],
            },
          },
        },
        baseHash: "abc123",
      }),
    ).toBe(false);
  });

  it("requires command spans to have non-negative starts and positive exclusive ends", () => {
    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: 0, endIndex: 4 }],
      }),
    ).toBe(true);

    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: 0, endIndex: 0 }],
      }),
    ).toBe(false);

    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: -1, endIndex: 4 }],
      }),
    ).toBe(false);
  });

  it("accepts only optional unavailable approval decisions", () => {
    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        unavailableDecisions: ["allow-always"],
      }),
    ).toBe(true);

    for (const unavailableDecisions of [
      [],
      ["allow-always", "allow-always"],
      ["allow-once"],
      ["deny"],
    ]) {
      expect(
        validateExecApprovalRequestParams({
          command: "echo hi",
          unavailableDecisions,
        }),
      ).toBe(false);
    }
  });
});
