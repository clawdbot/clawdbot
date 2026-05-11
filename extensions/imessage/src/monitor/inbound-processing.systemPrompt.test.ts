import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

type DecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

function buildCfgWithGroups(
  groups: Record<string, { requireMention?: boolean; systemPrompt?: string }>,
): OpenClawConfig {
  return {
    channels: {
      imessage: {
        groupPolicy: "allowlist",
        groups,
      },
    },
  } as unknown as OpenClawConfig;
}

function buildDecisionParams(overrides: Partial<DecisionParams> = {}): DecisionParams {
  return {
    cfg: overrides.cfg ?? ({} as OpenClawConfig),
    accountId: "default",
    message: {
      id: 1,
      sender: "+15555550123",
      text: "hi",
      is_from_me: false,
      is_group: true,
      chat_id: 7,
      chat_guid: "any;+;chatXYZ",
      chat_identifier: "chatXYZ",
      created_at: "2026-05-08T03:00:00Z",
    } as DecisionParams["message"],
    messageText: "hi",
    bodyText: "hi",
    allowFrom: ["+15555550123"],
    groupAllowFrom: ["+15555550123"],
    groupPolicy: "allowlist",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    logVerbose: undefined,
    ...overrides,
  };
}

describe("resolveIMessageInboundDecision per-group systemPrompt", () => {
  it("captures the per-chat_id systemPrompt on group dispatch decisions", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "7": { systemPrompt: "Keep responses under 3 sentences." },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Keep responses under 3 sentences.");
  });

  it("falls back to the groups['*'] wildcard systemPrompt", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Default group voice." },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Default group voice.");
  });

  it("prefers the per-chat_id systemPrompt over the wildcard when both are set", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Default group voice." },
          "7": { systemPrompt: "Specific group voice." },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Specific group voice.");
  });

  it("treats whitespace-only per-chat_id systemPrompt as suppression of the wildcard", async () => {
    // Mirrors WhatsApp semantic: defining the systemPrompt key on a specific
    // group entry (even as whitespace) means "this group has no prompt" and
    // suppresses the groups["*"] fallback.
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { systemPrompt: "   " },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBeUndefined();
  });

  it("treats explicit empty-string per-chat_id systemPrompt as suppression of the wildcard", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { systemPrompt: "" },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBeUndefined();
  });

  it("falls back to the wildcard when the per-chat_id entry has no systemPrompt key at all", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { requireMention: true },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Wildcard.");
  });

  it("does not set groupSystemPrompt on true DM decisions", async () => {
    // Use a chat_id that does NOT match any configured group entry, and
    // route through the DM-shaped message (is_group=false, no chat_id key
    // in groups). Without a groupConfig match the path stays a DM and the
    // group prompt must not bleed into the ctx.
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "999": { systemPrompt: "Other group." },
        }),
        message: {
          id: 1,
          sender: "+15555550123",
          text: "hi",
          is_from_me: false,
          is_group: false,
          chat_id: 42,
          chat_identifier: "+15555550123",
          destination_caller_id: "+15555550456",
          created_at: "2026-05-08T03:00:00Z",
        } as DecisionParams["message"],
        groupPolicy: "open",
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.isGroup).toBe(false);
    expect(decision.groupSystemPrompt).toBeUndefined();
  });
});

describe("buildIMessageInboundContext forwards GroupSystemPrompt", () => {
  function buildBuildParams(decision: {
    isGroup: boolean;
    groupSystemPrompt?: string;
  }): Parameters<typeof buildIMessageInboundContext>[0] {
    return {
      cfg: {} as OpenClawConfig,
      decision: {
        kind: "dispatch",
        isGroup: decision.isGroup,
        chatId: decision.isGroup ? 7 : undefined,
        chatGuid: decision.isGroup ? "any;+;chatXYZ" : "any;-;+15555550123",
        chatIdentifier: decision.isGroup ? "chatXYZ" : "+15555550123",
        groupId: decision.isGroup ? "7" : undefined,
        historyKey: undefined,
        sender: "+15555550123",
        senderNormalized: "+15555550123",
        route: {
          accountId: "default",
          agentId: "lobster",
          channel: "imessage",
          sessionKey: "k",
          mainSessionKey: "mk",
          lastRoutePolicy: "main",
          matchedBy: "default",
        },
        bodyText: "hi",
        createdAt: undefined,
        replyContext: null,
        effectiveWasMentioned: false,
        commandAuthorized: false,
        effectiveDmAllowFrom: [],
        effectiveGroupAllowFrom: [],
        groupSystemPrompt: decision.groupSystemPrompt,
      } as Parameters<typeof buildIMessageInboundContext>[0]["decision"],
      message: {
        sender: "+15555550123",
        text: "hi",
        is_group: decision.isGroup,
        chat_id: decision.isGroup ? 7 : undefined,
        chat_name: decision.isGroup ? "Test Group" : undefined,
      } as Parameters<typeof buildIMessageInboundContext>[0]["message"],
      historyLimit: 0,
      groupHistories: new Map(),
    } as Parameters<typeof buildIMessageInboundContext>[0];
  }

  it("sets ctxPayload.GroupSystemPrompt for group messages", () => {
    const { ctxPayload } = buildIMessageInboundContext(
      buildBuildParams({ isGroup: true, groupSystemPrompt: "Be concise." }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBe("Be concise.");
  });

  it("leaves ctxPayload.GroupSystemPrompt undefined when no per-group prompt is configured", () => {
    const { ctxPayload } = buildIMessageInboundContext(
      buildBuildParams({ isGroup: true, groupSystemPrompt: undefined }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBeUndefined();
  });

  it("leaves ctxPayload.GroupSystemPrompt undefined for DMs even if a prompt is somehow on decision", () => {
    const { ctxPayload } = buildIMessageInboundContext(
      buildBuildParams({ isGroup: false, groupSystemPrompt: "should-not-leak" }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBeUndefined();
  });
});
