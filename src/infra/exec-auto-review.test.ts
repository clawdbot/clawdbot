// Covers conservative default exec auto-review decisions.
import { describe, expect, it } from "vitest";
import {
  buildExecAutoReviewFailureDecision,
  defaultExecAutoReviewer,
  normalizeExecAutoReviewRationale,
  resolveExecAutoReviewDecision,
  type ExecAutoReviewInput,
  type ExecAutoReviewer,
} from "./exec-auto-review.js";

const reviewInput = {
  command: "git status",
  argv: ["git", "status"],
  host: "gateway",
  reason: "approval-required",
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
} satisfies ExecAutoReviewInput;

function reviewCommand(command: string, argv: string[]) {
  return defaultExecAutoReviewer({
    command,
    argv,
    host: "gateway",
    reason: "approval-required",
    analysis: {
      parsed: true,
      allowlistMatched: false,
      inlineEval: false,
    },
  } satisfies ExecAutoReviewInput);
}

describe("default exec auto reviewer", () => {
  it("falls back to human approval instead of maintaining a static allowlist", () => {
    expect(reviewCommand("pwd", ["pwd"])).toMatchObject({
      decision: "ask",
    });
  });

  it.each([
    ["./pwd", ["./pwd"]],
    ["/tmp/pwd", ["/tmp/pwd"]],
  ])("does not auto-approve path-qualified pwd lookalikes: %s", (_command, argv) => {
    expect(reviewCommand(_command, argv)).toMatchObject({
      decision: "ask",
    });
  });

  it.each([
    ["cat ~/.openclaw/credentials/model.json", ["cat", "~/.openclaw/credentials/model.json"]],
    ["rg token ~/.ssh", ["rg", "token", "~/.ssh"]],
    ["sed -i s/foo/bar/g file.txt", ["sed", "-i", "s/foo/bar/g", "file.txt"]],
    ["git status", ["git", "status"]],
    ["git branch scratch", ["git", "branch", "scratch"]],
    ["git diff --output=/tmp/diff.patch", ["git", "diff", "--output=/tmp/diff.patch"]],
    ["git status\nnode -e 'console.log(1)'", ["git", "status"]],
  ])(
    "asks for human review on sensitive or externally influenced commands: %s",
    (_command, argv) => {
      expect(reviewCommand(_command, argv)).toMatchObject({
        decision: "ask",
      });
    },
  );
});

describe("exec auto-review failure handling", () => {
  it.each([
    {
      name: "newlines, terminal controls, and bidirectional text",
      value: "first\n\u001b[31msecond\u001b[0m\u202e",
      expected: "first\\nsecond",
    },
    {
      name: "operating-system command sequences",
      value: "first\u001b]0;hidden title\u0007second",
      expected: "firstsecond",
    },
    {
      name: "Unicode line separators",
      value: "first\u2028second\u2029third",
      expected: "firstsecondthird",
    },
    { name: "empty provider explanations", value: "", expected: "review failed" },
    { name: "missing provider explanations", value: undefined, expected: "review failed" },
  ])("normalizes $name before human approval", ({ value, expected }) => {
    expect(normalizeExecAutoReviewRationale(value, "review failed")).toBe(expected);
  });

  it("bounds the complete failure rationale without splitting surrogate pairs", () => {
    const decision = buildExecAutoReviewFailureDecision(
      "exec reviewer failed",
      "x".repeat(477) + "🚀tail",
    );

    expect(decision).toMatchObject({ decision: "ask", risk: "unknown" });
    expect(decision.rationale.length).toBeLessThanOrEqual(500);
    expect(decision.rationale).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it.each([
    {
      name: "throws synchronously",
      reviewer: () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
    {
      name: "rejects asynchronously",
      reviewer: async () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
  ])("defers when a reviewer $name", async ({ reviewer }) => {
    await expect(resolveExecAutoReviewDecision(reviewer, reviewInput)).resolves.toEqual({
      decision: "ask",
      risk: "unknown",
      rationale: "exec reviewer failed: provider\\nfailed",
    });
  });

  it("preserves a successful reviewer's original decision", async () => {
    const decision = {
      decision: "allow-once",
      risk: "low",
      rationale: "read-only inspection",
    } as const;
    const reviewer: ExecAutoReviewer = () => decision;

    await expect(resolveExecAutoReviewDecision(reviewer, reviewInput)).resolves.toBe(decision);
  });

  it("redacts provider credentials before displaying a reviewer failure", async () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const reviewer: ExecAutoReviewer = () => {
      throw new Error(`Authorization: Bearer ${secret}`);
    };

    const decision = await resolveExecAutoReviewDecision(reviewer, reviewInput);

    expect(decision).toMatchObject({ decision: "ask", risk: "unknown" });
    expect(decision.rationale).not.toContain(secret);
  });
});
