import { describe, expect, it } from "vitest";

import {
  extractShortModelName,
  hasTemplateVariables,
  resolveResponsePrefixTemplate,
} from "./response-prefix-template.js";

describe("resolveResponsePrefixTemplate", () => {
  it("returns undefined for undefined template", () => {
    expect(resolveResponsePrefixTemplate(undefined, {})).toBeUndefined();
  });

  it("returns template as-is when no variables present", () => {
    expect(resolveResponsePrefixTemplate("[Claude]", {})).toBe("[Claude]");
  });

  it("resolves {model} variable", () => {
    const result = resolveResponsePrefixTemplate("[{model}]", {
      model: "gpt-5.2",
    });
    expect(result).toBe("[gpt-5.2]");
  });

  it("resolves {modelFull} variable", () => {
    const result = resolveResponsePrefixTemplate("[{modelFull}]", {
      modelFull: "openai-codex/gpt-5.2",
    });
    expect(result).toBe("[openai-codex/gpt-5.2]");
  });

  it("resolves {provider} variable", () => {
    const result = resolveResponsePrefixTemplate("[{provider}]", {
      provider: "anthropic",
    });
    expect(result).toBe("[anthropic]");
  });

  it("resolves {thinkingLevel} variable", () => {
    const result = resolveResponsePrefixTemplate("think:{thinkingLevel}", {
      thinkingLevel: "high",
    });
    expect(result).toBe("think:high");
  });

  it("resolves {think} as alias for thinkingLevel", () => {
    const result = resolveResponsePrefixTemplate("think:{think}", {
      thinkingLevel: "low",
    });
    expect(result).toBe("think:low");
  });

  it("resolves {identity.name} variable", () => {
    const result = resolveResponsePrefixTemplate("[{identity.name}]", {
      identityName: "Clawdbot",
    });
    expect(result).toBe("[Clawdbot]");
  });

  it("resolves {identityName} as alias", () => {
    const result = resolveResponsePrefixTemplate("[{identityName}]", {
      identityName: "Clawdbot",
    });
    expect(result).toBe("[Clawdbot]");
  });

  it("resolves multiple variables", () => {
    const result = resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
      model: "claude-opus-4-5",
      thinkingLevel: "high",
    });
    expect(result).toBe("[claude-opus-4-5 | think:high]");
  });

  it("leaves unresolved variables as-is", () => {
    const result = resolveResponsePrefixTemplate("[{model}]", {});
    expect(result).toBe("[{model}]");
  });

  it("leaves unrecognized variables as-is", () => {
    const result = resolveResponsePrefixTemplate("[{unknownVar}]", {
      model: "gpt-5.2",
    });
    expect(result).toBe("[{unknownVar}]");
  });

  it("handles case insensitivity", () => {
    const result = resolveResponsePrefixTemplate("[{MODEL} | {ThinkingLevel}]", {
      model: "gpt-5.2",
      thinkingLevel: "low",
    });
    expect(result).toBe("[gpt-5.2 | low]");
  });

  it("handles mixed resolved and unresolved variables", () => {
    const result = resolveResponsePrefixTemplate("[{model} | {provider}]", {
      model: "gpt-5.2",
      // provider not provided
    });
    expect(result).toBe("[gpt-5.2 | {provider}]");
  });

  it("handles complex template with all variables", () => {
    const result = resolveResponsePrefixTemplate(
      "[{identity.name}] {provider}/{model} (think:{thinkingLevel})",
      {
        identityName: "Clawdbot",
        provider: "anthropic",
        model: "claude-opus-4-5",
        thinkingLevel: "high",
      },
    );
    expect(result).toBe("[Clawdbot] anthropic/claude-opus-4-5 (think:high)");
  });
});

describe("extractShortModelName", () => {
  it("strips provider prefix", () => {
    expect(extractShortModelName("openai/gpt-5.2")).toBe("gpt-5.2");
    expect(extractShortModelName("anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(extractShortModelName("openai-codex/gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("strips date suffix", () => {
    expect(extractShortModelName("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(extractShortModelName("gpt-5.2-20250115")).toBe("gpt-5.2");
  });

  it("strips -latest suffix", () => {
    expect(extractShortModelName("gpt-5.2-latest")).toBe("gpt-5.2");
    expect(extractShortModelName("claude-sonnet-latest")).toBe("claude-sonnet");
  });

  it("handles model without provider", () => {
    expect(extractShortModelName("gpt-5.2")).toBe("gpt-5.2");
    expect(extractShortModelName("claude-opus-4-5")).toBe("claude-opus-4-5");
  });

  it("handles full path with provider and date suffix", () => {
    expect(extractShortModelName("anthropic/claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
  });

  it("preserves version numbers that look like dates but are not", () => {
    // Date suffix must be exactly 8 digits at the end
    expect(extractShortModelName("model-v1234567")).toBe("model-v1234567");
    expect(extractShortModelName("model-123456789")).toBe("model-123456789");
  });
});

describe("hasTemplateVariables", () => {
  it("returns false for undefined", () => {
    expect(hasTemplateVariables(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasTemplateVariables("")).toBe(false);
  });

  it("returns false for static prefix", () => {
    expect(hasTemplateVariables("[Claude]")).toBe(false);
  });

  it("returns true when template variables present", () => {
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("{provider}")).toBe(true);
    expect(hasTemplateVariables("prefix {thinkingLevel} suffix")).toBe(true);
  });

  it("returns true for multiple variables", () => {
    expect(hasTemplateVariables("[{model} | {provider}]")).toBe(true);
  });

  it("handles consecutive calls correctly (regex lastIndex reset)", () => {
    // First call
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    // Second call should still work
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    // Static string should return false
    expect(hasTemplateVariables("[Claude]")).toBe(false);
  });
});
