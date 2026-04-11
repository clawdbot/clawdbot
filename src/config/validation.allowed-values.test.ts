import { describe, expect, it } from "vitest";
import { __testing, validateConfigObjectRaw } from "./validation.js";
import { SignalConfigSchema } from "./zod-schema.providers-core.js";

function mapFirstIssue(
  schema: { safeParse: (value: unknown) => { success: true } | { success: false; error: unknown } },
  value: unknown,
) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected schema parse failure");
  }
  const issue = (result.error as { issues?: unknown[] }).issues?.[0];
  expect(issue).toBeDefined();
  return __testing.mapZodIssueToConfigIssue(issue);
}

describe("config validation allowed-values metadata", () => {
  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "update.channel");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('(allowed: "stable", "beta", "dev")');
      expect(issue?.allowedValues).toEqual(["stable", "beta", "dev"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("keeps native enum messages while attaching allowed values metadata", () => {
    const issue = mapFirstIssue(SignalConfigSchema, { dmPolicy: "maybe" });
    expect(issue.path).toBe("dmPolicy");
    expect(issue.message).toContain("expected one of");
    expect(issue.message).not.toContain("(allowed:");
    expect(issue.allowedValues).toEqual(["pairing", "allowlist", "open", "disabled"]);
    expect(issue.allowedValuesHiddenCount).toBe(0);
  });

  it("includes boolean variants for boolean-or-enum unions", () => {
    const issue = __testing.mapZodIssueToConfigIssue({
      code: "custom",
      path: ["channels", "telegram"],
      message:
        "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy",
    });
    expect(issue.path).toBe("channels.telegram");
    expect(issue.message).toContain(
      "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy",
    );
    expect(issue.allowedValues).toBeUndefined();
  });

  it("skips allowed-values hints for unions with open-ended branches", () => {
    const result = validateConfigObjectRaw({
      cron: { sessionRetention: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "cron.sessionRetention");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
      expect(issue?.allowedValuesHiddenCount).toBeUndefined();
      expect(issue?.message).not.toContain("(allowed:");
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
      expect(result.issues).not.toContainEqual({
        path: "bindings.0",
        message: "Invalid input",
      });
      expect(result.issues).toContainEqual({
        path: "bindings.0.acp",
        message: 'Unrecognized key: "agent"',
      });
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
      expect(result.issues).not.toContainEqual({
        path: "bindings.0.type",
        message: 'Invalid input: expected "route"',
      });
      expect(result.issues).toContainEqual({
        path: "bindings.0",
        message: 'Unrecognized key: "extraTopLevel"',
      });
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
      expect(result.issues).not.toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input: expected string, received boolean",
      });
      expect(result.issues).not.toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input: expected object, received boolean",
      });
      expect(result.issues).toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input",
      });
    }
  });
});
