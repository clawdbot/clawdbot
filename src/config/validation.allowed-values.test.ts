import { describe, expect, it } from "vitest";
import { z } from "zod";
import { __testing, validateConfigObjectRaw } from "./validation.js";

function requireIssue<T extends { path: string }>(issues: T[], path: string): T {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

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
  if (!issue) {
    throw new Error("expected first zod issue");
  }
  return __testing.mapZodIssueToConfigIssue(issue);
}

describe("config validation allowed-values metadata", () => {
  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "update.channel");
      expect(issue.message).toContain('(allowed: "stable", "beta", "dev")');
      expect(issue.allowedValues).toEqual(["stable", "beta", "dev"]);
      expect(issue.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("keeps native enum messages while attaching allowed values metadata", () => {
    const issue = mapFirstIssue(
      z.object({ dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]) }),
      { dmPolicy: "maybe" },
    );
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
      const issue = requireIssue(result.issues, "cron.sessionRetention");
      expect(issue.allowedValues).toBeUndefined();
      expect(issue.allowedValuesHiddenCount).toBeUndefined();
      expect(issue.message).not.toContain("(allowed:");
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
