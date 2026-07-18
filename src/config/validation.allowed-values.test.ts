// Verifies config validation rejects unsupported enumerated values.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

function requireIssue<T extends { path: string }>(issues: T[], path: string): T {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

describe("config validation allowed-values metadata", () => {
  it("accepts extended-stable as an additive update channel", () => {
    expect(
      validateConfigObjectRaw({
        update: { channel: "extended-stable" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "update.channel");
      expect(issue.pathSegments).toEqual(["update", "channel"]);
      expect(JSON.stringify(issue)).not.toContain("pathSegments");
      expect(issue.message).toContain('(allowed: "stable", "extended-stable", "beta", "dev")');
      expect(issue.allowedValues).toEqual(["stable", "extended-stable", "beta", "dev"]);
      expect(issue.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("skips allowed-values hints for unions with open-ended branches", () => {
    const result = validateConfigObjectRaw({
      cron: { sessionRetention: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "cron.sessionRetention");
      expect(issue.allowedValues).toBeUndefined();
      expect(issue.allowedValuesHiddenCount).toBeUndefined();
      expect(issue.message).not.toContain("(allowed:");
    }
  });

  it.each([
    { value: 15, expected: "(maximum: 14)" },
    { value: 0, expected: "(minimum: 1)" },
  ])("adds numeric bound hints for invalid startup context limits", ({ value, expected }) => {
    const result = validateConfigObjectRaw({
      agents: { defaults: { startupContext: { dailyMemoryDays: value } } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "agents.defaults.startupContext.dailyMemoryDays");
      expect(issue.message).toContain(expected);
    }
  });

  it("adds an exclusive lower-bound hint for positive config values", () => {
    const result = validateConfigObjectRaw({
      agents: { defaults: { maxConcurrent: 0 } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "agents.defaults.maxConcurrent");
      expect(issue.message).toContain("(must be greater than 0)");
    }
  });

  it("surfaces specific sub-issue for invalid_union bindings errors instead of generic 'Invalid input'", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          type: "acp",
          agentId: "test",
          match: { channel: "discord", peer: { kind: "direct", id: "123" } },
          acp: { agent: "claude" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "bindings.0.acp",
          message: 'Unrecognized key: "agent"',
        },
      ]);
    }
  });

  it("prefers the matching union branch for top-level unexpected keys", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          type: "acp",
          agentId: "test",
          match: { channel: "discord", peer: { kind: "direct", id: "123" } },
          acp: { mode: "persistent" },
          extraTopLevel: true,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "bindings.0",
          message: 'Unrecognized key: "extraTopLevel"',
        },
      ]);
    }
  });

  it("keeps generic union messaging for mixed scalar-or-object unions", () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [{ id: "a", model: true }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "agents.list.0.model",
          message: "Invalid input",
        },
      ]);
    }
  });
});

describe("config validation legacy openai-codex api", () => {
  it("names openai-chatgpt-responses for the removed openai-codex-responses api id", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            models: [{ id: "gpt-5.5", api: "openai-codex-responses" }],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const providerIssue = requireIssue(result.issues, "models.providers.openai-codex.api");
      expect(providerIssue.message).toContain('"openai-codex-responses" is a removed api id');
      expect(providerIssue.message).toContain('use "openai-chatgpt-responses"');
      const modelIssue = requireIssue(result.issues, "models.providers.openai-codex.models.0.api");
      expect(modelIssue.message).toContain('use "openai-chatgpt-responses"');
    }
  });

  it("keeps the generic enum message for other invalid api ids", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "models.providers.openai-codex.api");
      expect(issue.message).toContain("expected one of");
      expect(issue.message).not.toContain("removed api id");
    }
  });
});
