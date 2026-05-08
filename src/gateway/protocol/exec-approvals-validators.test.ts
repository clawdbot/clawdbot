import { describe, expect, it } from "vitest";
import {
  validateExecApprovalRequestParams,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "./index.js";

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
              lastUsedAt: 1775154056736,
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
});
