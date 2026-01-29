import { describe, expect, it } from "vitest";

import { __testing } from "./bash-tools.exec.js";

describe("exec resilient coding agent detection", () => {
  it("detects common coding agent binaries", () => {
    expect(__testing.isLikelyCodingAgentCommand("claude --version")).toBe(true);
    expect(__testing.isLikelyCodingAgentCommand("codex exec --full-auto 'hi'")).toBe(true);
    expect(__testing.isLikelyCodingAgentCommand("opencode run 'hi'")).toBe(true);
    expect(__testing.isLikelyCodingAgentCommand("pi 'hi'")).toBe(true);
  });

  it("handles leading env assignments", () => {
    expect(__testing.isLikelyCodingAgentCommand("FOO=bar BAR=baz claude --version")).toBe(true);
    expect(__testing.resolveLeadingCommandBinary("FOO=bar claude --version")).toBe("claude");
  });

  it("avoids double-wrapping already-resilient commands", () => {
    expect(
      __testing.isLikelyCodingAgentCommand(
        "bash ~/.clawdbot/skills/coding-agent/scripts/resilient-spawn.sh ~/proj claude 'hi' test",
      ),
    ).toBe(false);
    expect(__testing.isLikelyCodingAgentCommand("screen -dmS foo claude --version")).toBe(false);
    expect(
      __testing.isLikelyCodingAgentCommand("tmux new-session -d -s foo 'claude --version'"),
    ).toBe(false);
  });

  it("rejects non-coding commands", () => {
    expect(__testing.isLikelyCodingAgentCommand("")).toBe(false);
    expect(__testing.isLikelyCodingAgentCommand("echo hi")).toBe(false);
    expect(__testing.isLikelyCodingAgentCommand('bash -lc "claude --version"')).toBe(false);
  });
});
