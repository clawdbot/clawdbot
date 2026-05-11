import { describe, expect, it, vi } from "vitest";
import {
  formatAllowlistEntries,
  parseAllowlistEntries,
  promptChannelAccessConfig,
  promptChannelAllowlist,
  promptChannelAccessPolicy,
} from "./setup-group-access.js";

function createPrompter(params?: {
  confirm?: (options: { message: string; initialValue: boolean }) => Promise<boolean>;
  select?: (options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
  }) => Promise<string>;
  text?: (options: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }) => Promise<string>;
}) {
  return {
    confirm: vi.fn(params?.confirm ?? (async () => true)),
    select: vi.fn(params?.select ?? (async () => "allowlist")),
    text: vi.fn(params?.text ?? (async () => "")),
  };
}

describe("parseAllowlistEntries", () => {
  it("splits comma/newline/semicolon-separated entries", () => {
    expect(parseAllowlistEntries("alpha, beta\n gamma;delta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});

describe("formatAllowlistEntries", () => {
  it("formats compact comma-separated output", () => {
    expect(formatAllowlistEntries([" alpha ", "", "beta"])).toBe("alpha, beta");
  });
});

describe("promptChannelAllowlist", () => {
  it("uses existing entries as initial value", async () => {
    const prompter = createPrompter({
      text: async () => "one,two",
    });

    const result = await promptChannelAllowlist({
      prompter: prompter as any,
      label: "Test",
      currentEntries: ["alpha", "beta"],
    });

    expect(result).toEqual(["one", "two"]);
    expect(prompter.text).toHaveBeenCalledWith({
      message: "Test allowlist (comma-separated)",
      placeholder: undefined,
      initialValue: "alpha, beta",
    });
  });
});

describe("promptChannelAccessPolicy", () => {
  it("returns selected policy", async () => {
    const prompter = createPrompter({
      select: async () => "open",
    });

    const result = await promptChannelAccessPolicy({
      prompter: prompter as any,
      label: "Discord",
      currentPolicy: "allowlist",
    });

    expect(result).toBe("open");
  });
});

describe("promptChannelAccessConfig policy-only entries", () => {
  it("skips the allowlist text prompt when entries are policy-only", async () => {
    const prompter = createPrompter({
      confirm: async () => true,
      select: async () => "allowlist",
      text: async () => {
        throw new Error("text prompt should not run");
      },
    });

    const result = await promptChannelAccessConfig({
      prompter: prompter as any,
      label: "Twitch chat",
      skipAllowlistEntries: true,
    });

    expect(result).toEqual({ policy: "allowlist", entries: [] });
  });
});

describe("promptChannelAccessConfig skip flow", () => {
  it("returns null when user skips configuration", async () => {
    const prompter = createPrompter({
      confirm: async () => false,
    });

    const result = await promptChannelAccessConfig({
      prompter: prompter as any,
      label: "Slack",
    });

    expect(result).toBeNull();
  });

  it("returns allowlist entries when policy is allowlist", async () => {
    const prompter = createPrompter({
      confirm: async () => true,
      select: async () => "allowlist",
      text: async () => "c1, c2",
    });

    const result = await promptChannelAccessConfig({
      prompter: prompter as any,
      label: "Slack",
    });

    expect(result).toEqual({
      policy: "allowlist",
      entries: ["c1", "c2"],
    });
  });

  it("returns non-allowlist policy with empty entries", async () => {
    const prompter = createPrompter({
      confirm: async () => true,
      select: async () => "open",
    });

    const result = await promptChannelAccessConfig({
      prompter: prompter as any,
      label: "Slack",
      allowDisabled: true,
    });

    expect(result).toEqual({
      policy: "open",
      entries: [],
    });
  });
});
