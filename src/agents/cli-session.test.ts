/**
 * Regression coverage for CLI session persistence helpers.
 * Verifies provider-keyed bindings, legacy Claude state, and reuse invalidation.
 */
import { describe, expect, it } from "vitest";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import {
  normalizeCliSessionReseedReceipt,
  rebindCliSessionReseedReceiptsForReset,
} from "../config/sessions/cli-session-binding.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  resolveCliSessionReuse,
  setCliSessionBinding,
  setCliSessionId,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-hash",
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      mcpConfigHash: "mcp-hash",
      mcpResumeHash: "mcp-resume-hash",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-hash",
      messageToolPolicyHash: "message-policy-hash",
      promptToolNamesHash: "prompt-tools-hash",
      cwdHash: "cwd-hash",
      mcpConfigHash: "mcp-hash",
      mcpResumeHash: "mcp-resume-hash",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });
  });

  it("drops malformed reseed receipts while preserving the session binding", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: {
        version: 1,
        promptHash: "not-a-digest",
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted",
      },
    });

    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: undefined,
      authEpoch: undefined,
      authEpochVersion: undefined,
      extraSystemPromptHash: undefined,
      messageToolPolicyHash: undefined,
      promptToolNamesHash: undefined,
      cwdHash: undefined,
      mcpConfigHash: undefined,
      mcpResumeHash: undefined,
      reseedReceipt: undefined,
    });
  });

  it("rejects reseed receipts without a local session owner", () => {
    expect(
      normalizeCliSessionReseedReceipt({
        version: 1,
        promptHash: "a".repeat(64),
      } as CliSessionReseedReceipt),
    ).toBeUndefined();
  });

  it("rejects reseed receipts without a user-turn disposition", () => {
    expect(
      normalizeCliSessionReseedReceipt({
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
      } as CliSessionReseedReceipt),
    ).toBeUndefined();
  });

  it("rebinds only omitted receipts across binding-preserving resets", () => {
    const bindings = {
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: {
          version: 1 as const,
          promptHash: "a".repeat(64),
          localSessionId: "old-local-session",
          userTurnDisposition: "omitted" as const,
        },
      },
      "other-cli": {
        sessionId: "other-session",
        reseedReceipt: {
          version: 1 as const,
          promptHash: "b".repeat(64),
          localSessionId: "old-local-session",
          userTurnDisposition: "persisted" as const,
        },
      },
    };

    expect(rebindCliSessionReseedReceiptsForReset(bindings, "new-local-session")).toEqual({
      "claude-cli": {
        sessionId: "claude-session",
        reseedReceipt: {
          version: 1,
          promptHash: "a".repeat(64),
          localSessionId: "new-local-session",
          userTurnDisposition: "omitted",
        },
      },
      "other-cli": bindings["other-cli"],
    });
    expect(bindings["claude-cli"].reseedReceipt.localSessionId).toBe("old-local-session");
  });

  it("preserves receipts only while updating the same native CLI session", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    const receipt = {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId: "openclaw-session",
      userTurnDisposition: "persisted" as const,
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      reseedReceipt: receipt,
    });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-1" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(receipt);

    setCliSessionId(entry, "claude-cli", "cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toEqual(receipt);

    setCliSessionBinding(entry, "claude-cli", { sessionId: "cli-session-2" });
    expect(getCliSessionBinding(entry, "claude-cli")?.reseedReceipt).toBeUndefined();
  });

  it("force-reuses explicitly attached CLI sessions despite metadata drift", () => {
    const binding = {
      sessionId: "cli-session-1",
      forceReuse: true,
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(entry, "claude-cli"),
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "legacy-session" });
  });

  it("invalidates legacy bindings on mechanical changes and resumes on content drift", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        authProfileId: "anthropic:work",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "legacy-session",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-b",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        promptToolNamesHash: "prompt-tools-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["prompt-tools"] },
    });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("keeps content-drift bindings reusable for queued turns until hashes refresh", () => {
    const binding = {
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };
    const current = {
      binding,
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-b",
      mcpConfigHash: "mcp-a",
    };

    expect(resolveCliSessionReuse(current)).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(resolveCliSessionReuse(current)).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session-1",
      drift: { reasons: ["system-prompt"] },
    });
    expect(
      resolveCliSessionReuse({
        ...current,
        binding: { ...binding, extraSystemPromptHash: "prompt-b" },
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("invalidates reuse when message-tool prompt policy changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      messageToolPolicyHash: "message-policy-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        messageToolPolicyHash: "message-policy-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "message-policy" });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        messageToolPolicyHash: "message-policy-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("invalidates reuse when the task cwd changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authEpochVersion: 2,
      cwdHash: hashCliSessionText("/work/repo-a"),
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo-b"),
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "cwd" });
    expect(
      resolveCliSessionReuse({
        binding,
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo-a"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("does not invalidate legacy metadata before cwd hash backfill", () => {
    expect(
      resolveCliSessionReuse({
        binding: { sessionId: "cli-session-1" },
        authEpochVersion: 2,
        cwdHash: hashCliSessionText("/work/repo-a"),
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("reuses when auth profile ids rotate but the versioned auth epoch is stable", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work-alias",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("accepts unversioned auth epochs for binding upgrades", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "previous-auth-epoch",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("accepts older auth epoch versions for binding upgrades", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "refresh-token-auth-epoch",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "identity-auth-epoch",
        authEpochVersion: 3,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("accepts v3 bindings without authEpoch as binding upgrades to v4", () => {
    // Pre-v4 google-gemini-cli sessions persisted with authEpochVersion: 3
    // and no authEpoch (the local credential fingerprint returned undefined
    // before id_token identity lifting). The version-gate must skip the
    // epoch comparison for these so the next request after upgrade reuses
    // the stored session instead of forcing a one-time invalidation.
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: undefined,
      // authEpoch deliberately absent
      authEpochVersion: 3,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: undefined,
        authEpoch: "v4-identity-hash",
        authEpochVersion: 4,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("does not treat model changes as a session mismatch", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
  });

  it("prefers the stable MCP resume hash over the raw MCP config hash", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
      mcpResumeHash: "mcp-resume-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-a",
        mcpResumeHash: "mcp-resume-b",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("falls back to legacy MCP config hashes when stored resume hashes are absent", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-config-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-a",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "reuse", sessionId: "cli-session-1" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        authEpochVersion: 2,
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-config-b",
        mcpResumeHash: "mcp-resume-a",
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "mcp" });
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
