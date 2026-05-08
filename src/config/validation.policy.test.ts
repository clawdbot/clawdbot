import { describe, expect, it, vi } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: () => [],
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: () => [],
  listPluginDoctorLegacyConfigRules: () => [],
}));

vi.mock("../secrets/unsupported-surface-policy.js", async () => {
  const { isRecord } = await import("../utils.js");

  return {
    collectUnsupportedSecretRefConfigCandidates: (raw: unknown) => {
      if (!isRecord(raw)) {
        return [];
      }
      const candidates: Array<{ path: string; value: unknown }> = [];

      const hooks = isRecord(raw.hooks) ? raw.hooks : null;
      if (hooks) {
        candidates.push({ path: "hooks.token", value: hooks.token });
      }

      const channels = isRecord(raw.channels) ? raw.channels : null;
      const discord = channels && isRecord(channels.discord) ? channels.discord : null;
      const threadBindings =
        discord && isRecord(discord.threadBindings) ? discord.threadBindings : null;
      if (threadBindings) {
        candidates.push({
          path: "channels.discord.threadBindings.webhookToken",
          value: threadBindings.webhookToken,
        });
      }

      return candidates;
    },
  };
});

function requireIssue<T extends { path: string }>(issues: T[], path: string): T {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

describe("config validation SecretRef policy guards", () => {
  it("surfaces a policy error for hooks.token SecretRef objects", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: {
          source: "env",
          provider: "default",
          id: "HOOK_TOKEN",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "hooks.token");
      expect(issue.message).toContain("SecretRef objects are not supported at hooks.token");
      expect(issue.message).toContain(
        "https://docs.openclaw.ai/reference/secretref-credential-surface",
      );
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "hooks.token" &&
            entry.message.includes("Invalid input: expected string, received object"),
        ),
      ).toBe(false);
    }
  });

  it("keeps standard schema errors for non-SecretRef objects", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: {
          unexpected: "value",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "hooks.token");
      expect(issue.message).toBe("Invalid input: expected string, received object");
    }
  });

  it("allows env-template strings on unsupported mutable paths", () => {
    const result = validateConfigObjectRaw({
      hooks: {
        token: "${HOOK_TOKEN}",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("leaves legacy secretref-env marker migration to doctor", () => {
    const result = validateConfigObjectRaw({
      secrets: {
        defaults: {
          env: "gateway-env",
        },
      },
      channels: {
        discord: {
          token: "secretref-env:DISCORD_BOT_TOKEN",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("does not reject invalid legacy secretref-env markers during raw validation", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          token: "secretref-env:not-valid",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("replaces derived unrecognized-key errors with policy guidance for discord thread binding webhookToken", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          threadBindings: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "DISCORD_THREAD_BINDING_WEBHOOK_TOKEN",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const policyIssue = requireIssue(
        result.issues,
        "channels.discord.threadBindings.webhookToken",
      );
      expect(policyIssue.message).toContain(
        "SecretRef objects are not supported at channels.discord.threadBindings.webhookToken",
      );
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings" &&
            entry.message.includes('Unrecognized key: "webhookToken"'),
        ),
      ).toBe(false);
    }
  });

  it("preserves unrelated unknown-key errors when policy and typos coexist", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          threadBindings: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "DISCORD_THREAD_BINDING_WEBHOOK_TOKEN",
            },
            webhookTokne: "typo",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings.webhookToken" &&
            entry.message.includes("SecretRef objects are not supported"),
        ),
      ).toBe(true);
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "channels.discord.threadBindings" &&
            entry.message.includes("webhookTokne"),
        ),
      ).toBe(true);
    }
  });
});
