import { describe, expect, it } from "vitest";

import {
  type AuthProfileStore,
  CLAUDE_CLI_PROFILE_ID,
} from "../agents/auth-profiles.js";
import { buildAuthChoiceOptions } from "./auth-choice-options.js";

describe("buildAuthChoiceOptions", () => {
  it("includes GitHub Copilot", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: false,
      platform: "linux",
    });

    expect(options.find((opt) => opt.value === "github-copilot")).toBeDefined();
  });
  it("includes Claude CLI option on macOS even when missing", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    const claudeCli = options.find((opt) => opt.value === "claude-cli");
    expect(claudeCli).toBeDefined();
    expect(claudeCli?.hint).toBe("requires Keychain access");
  });

  it("skips missing Claude CLI option off macOS", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "linux",
    });

    expect(options.find((opt) => opt.value === "claude-cli")).toBeUndefined();
  });

  it("uses token hint when Claude CLI credentials exist", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [CLAUDE_CLI_PROFILE_ID]: {
          type: "token",
          provider: "anthropic",
          token: "token",
          expires: Date.now() + 60 * 60 * 1000,
        },
      },
    };

    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    const claudeCli = options.find((opt) => opt.value === "claude-cli");
    expect(claudeCli?.hint).toContain("token ok");
  });

  it("includes Z.AI (GLM) auth choice", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    expect(options.some((opt) => opt.value === "zai-api-key")).toBe(true);
  });

  it("includes MiniMax auth choice", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    expect(options.some((opt) => opt.value === "minimax-api")).toBe(true);
    expect(options.some((opt) => opt.value === "minimax-api-lightning")).toBe(
      true,
    );
  });

  it("includes Moonshot auth choice", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    expect(options.some((opt) => opt.value === "moonshot-api-key")).toBe(true);
  });

  it("includes Synthetic auth choice", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: "darwin",
    });

    expect(options.some((opt) => opt.value === "synthetic-api-key")).toBe(true);
  });
});
