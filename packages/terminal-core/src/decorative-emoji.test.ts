import { describe, expect, it } from "vitest";
import {
  decorativeEmoji,
  decorativePrefix,
  stripDecorativeEmojiForTerminal,
  supportsDecorativeEmoji,
} from "./decorative-emoji.js";

describe("decorative emoji terminal helpers", () => {
  it("disables decorative emoji without a TTY", () => {
    expect(supportsDecorativeEmoji({ env: { TERM: "xterm-256color" }, isTty: false })).toBe(false);
  });

  it("disables decorative emoji for dumb or non-UTF-8 terminals", () => {
    expect(
      supportsDecorativeEmoji({ env: { TERM: "dumb", LANG: "en_US.UTF-8" }, isTty: true }),
    ).toBe(false);
    expect(
      supportsDecorativeEmoji({
        env: { TERM: "xterm-256color", LANG: "C" },
        isTty: true,
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it("keeps emoji for known-good terminal programs", () => {
    expect(
      supportsDecorativeEmoji({
        env: { TERM_PROGRAM: "WezTerm", LANG: "en_US.UTF-8" },
        isTty: true,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("keeps emoji on macOS and drops it on generic Linux terminals", () => {
    expect(
      supportsDecorativeEmoji({
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        isTty: true,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(
      supportsDecorativeEmoji({
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        isTty: true,
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("formats decorative emoji prefixes conservatively", () => {
    const badTerminal = {
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "linux" as const,
    };
    const goodTerminal = {
      env: { TERM_PROGRAM: "ghostty", LANG: "en_US.UTF-8" },
      isTty: true,
    };

    expect(decorativeEmoji("🦞", badTerminal)).toBe("");
    expect(decorativePrefix("🦞", "OpenClaw", badTerminal)).toBe("OpenClaw");
    expect(decorativePrefix("🦞", "OpenClaw", goodTerminal)).toBe("🦞 OpenClaw");
  });

  it("strips decorative emoji from curated terminal text only when unsupported", () => {
    const badTerminal = {
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "linux" as const,
    };
    const goodTerminal = {
      env: { TERM_PROGRAM: "iTerm.app", LANG: "en_US.UTF-8" },
      isTty: true,
    };

    expect(stripDecorativeEmojiForTerminal("The lobster in your shell. 🦞", badTerminal)).toBe(
      "The lobster in your shell.",
    );
    expect(stripDecorativeEmojiForTerminal("The lobster in your shell. 🦞", goodTerminal)).toBe(
      "The lobster in your shell. 🦞",
    );
  });
});
