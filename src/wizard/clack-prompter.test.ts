import { afterEach, describe, expect, it, vi } from "vitest";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
    };

    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "GPT 5.4",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});

describe("createClackPrompter", () => {
  it("prints plain output without note framing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompter = createClackPrompter();

    await prompter.plain?.('{"ok":true}');

    expect(write).toHaveBeenCalledWith('{"ok":true}\n');
  });
});
