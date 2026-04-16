import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "./exec-approval-command-display.js";

describe("sanitizeExecApprovalDisplayText", () => {
  it.each([
    ["echo hi\u200Bthere", "echo hi\\u{200B}there"],
    ["date\u3164\uFFA0\u115F\u1160가", "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가"],
  ])("sanitizes exec approval display text for %j", (input, expected) => {
    expect(sanitizeExecApprovalDisplayText(input)).toBe(expected);
  });

  it("redacts bearer tokens embedded in commands", () => {
    const cmd =
      'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig" https://api.example.com';
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig");
    expect(result).toContain("curl");
    expect(result).toContain("https://api.example.com");
  });

  it("redacts API keys in environment variable assignments", () => {
    const cmd = 'API_SECRET="sk-abc123456789012345678" python script.py';
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123456789012345678");
    expect(result).toContain("python script.py");
  });

  it("redacts GitHub personal access tokens", () => {
    const cmd = "git clone https://ghp_1234567890abcdefghij1234567890abcdef@github.com/user/repo";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("ghp_1234567890abcdefghij1234567890abcdef");
    expect(result).toContain("git clone");
  });
});

describe("resolveExecApprovalCommandDisplay", () => {
  it.each([
    {
      name: "prefers explicit command fields and drops identical previews after trimming",
      input: {
        command: "echo hi",
        commandPreview: "  echo hi  ",
        host: "gateway" as const,
      },
      expected: {
        commandText: "echo hi",
        commandPreview: null,
      },
    },
    {
      name: "falls back to node systemRunPlan values and sanitizes preview text",
      input: {
        command: "",
        host: "node" as const,
        systemRunPlan: {
          argv: ["python3", "-c", "print(1)"],
          cwd: null,
          commandText: 'python3 -c "print(1)"',
          commandPreview: "print\u200B(1)",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: 'python3 -c "print(1)"',
        commandPreview: "print\\u{200B}(1)",
      },
    },
    {
      name: "ignores systemRunPlan fallback for non-node hosts",
      input: {
        command: "",
        host: "sandbox" as const,
        systemRunPlan: {
          argv: ["echo", "hi"],
          cwd: null,
          commandText: "echo hi",
          commandPreview: "echo hi",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: "",
        commandPreview: null,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveExecApprovalCommandDisplay(input)).toEqual(expected);
  });
});
