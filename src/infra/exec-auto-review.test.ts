import { describe, expect, it } from "vitest";
import { defaultExecAutoReviewer, type ExecAutoReviewInput } from "./exec-auto-review.js";

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
