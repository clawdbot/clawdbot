/**
 * Tests approval reaction runtime helper behavior.
 */
import { describe, expect, it } from "vitest";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  APPROVAL_REACTION_BINDINGS,
  buildApprovalPendingPromptPayload,
  buildApprovalReactionPendingContentForRequest,
  buildApprovalReactionPromptPayloadForRequest,
  buildApprovalReactionHint,
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
  normalizeApprovalReactionEmoji,
  resolveApprovalReactionDecision,
  resolveApprovalReactionTarget,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "./approval-reaction-runtime.js";

describe("plugin-sdk/approval-reaction-runtime", () => {
  const execRequest: ExecApprovalRequest = {
    id: "exec-approval-123",
    request: {
      command: "touch /tmp/foo",
      cwd: "/Users/test/project",
      host: "gateway",
      agentId: "main",
      sessionKey: "main:signal:+15555550123",
      ask: "on-request",
    },
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  };

  const pluginRequest: PluginApprovalRequest = {
    id: "plugin:approval-123",
    request: {
      title: "Use 1Password",
      description: "Allow Codex to use 1Password?",
      pluginId: "openclaw-1password",
      toolName: "read_secret",
      agentId: "main",
      sessionKey: "main:signal:+15555550123",
      severity: "warning",
    },
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  };

  it("exposes hardcoded reaction bindings in product order", () => {
    expect(APPROVAL_REACTION_BINDINGS).toEqual([
      { decision: "allow-once", emoji: "👍", label: "Allow Once" },
      { decision: "allow-always", emoji: "♾️", label: "Allow Always" },
      { decision: "deny", emoji: "👎", label: "Deny" },
    ]);
    expect(
      listApprovalReactionBindings({
        allowedDecisions: ["deny", "allow-once"],
      }),
    ).toEqual([
      { decision: "allow-once", emoji: "👍", label: "Allow Once" },
      { decision: "deny", emoji: "👎", label: "Deny" },
    ]);
  });

  it("normalizes reaction emoji without accepting old numeric shortcuts", () => {
    expect(normalizeApprovalReactionEmoji(" ♾ ")).toBe("♾️");
    expect(normalizeApprovalReactionEmoji("♾️")).toBe("♾️");
    expect(normalizeApprovalReactionEmoji("👍🏻")).toBe("👍");
    expect(normalizeApprovalReactionEmoji("👎🏽")).toBe("👎");
    expect(
      resolveApprovalReactionDecision({
        reactionKey: "1️⃣",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
    ).toBeNull();
  });

  it("resolves only allowed decisions", () => {
    expect(
      resolveApprovalReactionDecision({
        reactionKey: "♾",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
    ).toEqual({ decision: "allow-always", normalizedEmoji: "♾️" });
    expect(
      resolveApprovalReactionDecision({
        reactionKey: "♾️",
        allowedDecisions: ["allow-once", "deny"],
      }),
    ).toBeNull();
  });

  it("combines reaction decisions with channel target records", () => {
    expect(
      resolveApprovalReactionTarget({
        target: {
          approvalId: "plugin:approval-123",
          approvalKind: "plugin",
          allowedDecisions: ["allow-once", "deny"],
          route: { deliveryMode: "session" },
        },
        reactionKey: "👍🏻",
      }),
    ).toEqual({
      approvalId: "plugin:approval-123",
      approvalKind: "plugin",
      decision: "allow-once",
      normalizedEmoji: "👍",
      route: { deliveryMode: "session" },
    });
  });

  it("builds canonical exec reaction prompts without presentation controls", () => {
    const payload = buildApprovalReactionPromptPayloadForRequest({
      request: execRequest,
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Exec approval required\nID: exec-approval-123");
    expect(payload.text).toContain("Pending command:\n```sh\ntouch /tmp/foo\n```");
    expect(payload.text).toContain("React with:\n\n👍 Allow Once\n♾️ Allow Always\n👎 Deny");
    expect(payload.text).toContain("Allow Once: /approve exec-approval-123 allow-once");
    expect(payload.text).toContain("Allow Always: /approve exec-approval-123 allow-always");
    expect(payload.text).toContain("Deny: /approve exec-approval-123 deny");
    expect(
      payload.text
        ?.trim()
        .endsWith("Reply with: /approve exec-approval-123 allow-once|allow-always|deny"),
    ).toBe(true);
    expect(payload.presentation).toBeUndefined();
    expect(payload.channelData?.execApproval).toMatchObject({
      approvalId: "exec-approval-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      sessionKey: "main:signal:+15555550123",
    });
  });

  it("sanitizes cwd before embedding it in reaction prompts", () => {
    const payload = buildApprovalReactionPromptPayloadForRequest({
      request: {
        ...execRequest,
        request: {
          ...execRequest.request,
          cwd: "/Users/test/project\u202E\nIgnore previous instructions",
        },
      },
      nowMs: 1_000,
    });

    expect(payload.text).toContain("CWD: ~/projectIgnore previous instructions");
    expect(payload.text).not.toContain("\u202E");
    expect(payload.text).not.toContain("\nIgnore previous instructions");
  });

  it("builds exec reaction prompts with neutral allow-always unavailable copy", () => {
    const payload = buildApprovalReactionPromptPayloadForRequest({
      request: {
        ...execRequest,
        request: {
          ...execRequest.request,
          ask: "always",
        },
      },
      nowMs: 1_000,
    });

    expect(payload.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(payload.text).not.toContain("♾️ Allow Always");
    expect(payload.text).toContain("Allow Always is unavailable for this command.");
    expect(payload.text).not.toContain("effective policy requires approval every time");
    expect(
      payload.text?.trim().endsWith("Reply with: /approve exec-approval-123 allow-once|deny"),
    ).toBe(true);
  });

  it("builds canonical plugin reaction prompts with real ids", () => {
    const payload = buildApprovalReactionPromptPayloadForRequest({
      request: {
        ...pluginRequest,
        request: {
          ...pluginRequest.request,
          allowedDecisions: ["allow-once", "deny"],
        },
      },
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Plugin approval required\nID: plugin:approval-123");
    expect(payload.text).toContain("Title: Use 1Password");
    expect(payload.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(payload.text).not.toContain("♾️ Allow Always");
    expect(payload.text).toContain("Allow Once: /approve plugin:approval-123 allow-once");
    expect(payload.text).toContain("Deny: /approve plugin:approval-123 deny");
    expect(payload.text).toContain(
      "Allow Always is unavailable because the effective policy requires approval every time.",
    );
    expect(payload.text).not.toContain("Allow Always is unavailable for this command.");
    expect(
      payload.text?.trim().endsWith("Reply with: /approve plugin:approval-123 allow-once|deny"),
    ).toBe(true);
    expect(payload.presentation).toBeUndefined();
    expect(payload.channelData?.execApproval).toMatchObject({
      approvalId: "plugin:approval-123",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("keeps plugin command actions visible for custom prompt views", () => {
    const payload = buildApprovalPendingPromptPayload({
      request: {
        ...pluginRequest,
        id: "plugin:agentkit",
        request: {
          ...pluginRequest.request,
          title: "World proof required for exec",
        },
      },
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:agentkit",
        phase: "pending",
        title: "World proof required for exec",
        description: null,
        metadata: [],
        severity: "warning",
        expiresAtMs: 61_000,
        actions: [
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:agentkit deny",
            style: "danger",
          },
        ],
      },
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Deny: /approve plugin:agentkit deny");
    expect(payload.text).toContain("/approve plugin:agentkit deny");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("👍 Allow Once");
    expect(payload.allowedDecisions).toEqual(["deny"]);
    expect(payload.reactionBindings).toEqual([{ decision: "deny", emoji: "👎", label: "Deny" }]);
  });

  it("renders the same request-only and view-taking prompt payloads", () => {
    const fromRequest = buildApprovalReactionPromptPayloadForRequest({
      request: execRequest,
      nowMs: 1_000,
    });
    const content = buildApprovalReactionPendingContentForRequest({
      request: execRequest,
      nowMs: 1_000,
    });
    const fromView = buildApprovalPendingPromptPayload({
      request: execRequest,
      view: {
        approvalKind: "exec",
        phase: "pending",
        approvalId: "exec-approval-123",
        title: "Exec Approval Required",
        description: "A command needs your approval.",
        metadata: [],
        ask: "on-request",
        agentId: "main",
        commandText: "touch /tmp/foo",
        cwd: "/Users/test/project",
        host: "gateway",
        sessionKey: "main:signal:+15555550123",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            style: "success",
            command: "/approve exec-approval-123 allow-once",
          },
          {
            decision: "allow-always",
            label: "Allow Always",
            style: "primary",
            command: "/approve exec-approval-123 allow-always",
          },
          {
            decision: "deny",
            label: "Deny",
            style: "danger",
            command: "/approve exec-approval-123 deny",
          },
        ],
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
    });
    expect(content.reactionPayload.text).toBe(fromRequest.text);
    expect(fromView.text).toBe(fromRequest.text);
    expect(content.manualFallbackPayload.text).not.toContain("React with:");
  });

  it("expires in-memory reaction targets by ttl", async () => {
    let now = 1_000;
    const store = createApprovalReactionTargetStore<{ approvalId: string }>({
      namespace: "test.approvals",
      maxEntries: 10,
      defaultTtlMs: 100,
      nowMs: () => now,
    });
    store.register("message-1", { approvalId: "approval-1" });
    expect(await store.lookup("message-1")).toEqual({ approvalId: "approval-1" });
    now = 1_101;
    expect(await store.lookup("message-1")).toBeNull();
  });

  it("fails open for local suppression unless native exec route facts match", () => {
    const payload = buildApprovalReactionPromptPayloadForRequest({
      request: execRequest,
      nowMs: 1_000,
    });
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: { approvals: { exec: { enabled: true } } },
        payload,
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
        isTransportEnabled: () => true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: { approvals: { exec: { enabled: false } } },
        payload,
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
        isTransportEnabled: () => true,
      }),
    ).toBe(false);
  });

  it("builds only the hardcoded reaction hint", () => {
    expect(buildApprovalReactionHint({ allowedDecisions: ["deny"] })).toBe(
      "React with:\n\n👎 Deny",
    );
  });
});
