import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandingIntentTool } from "./standing-intents-tool.js";
import {
  buildStandingIntentContext,
  cancelStandingIntent,
  createStandingIntent as createStandingIntentRaw,
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  INTENT_INJECTION_MAX_CHARS,
  isEligibleStandingIntentTurn,
  listStandingIntents,
  matchStandingIntents,
  sweepStandingIntents,
} from "./standing-intents.js";

function createStandingIntent(
  params: Omit<Parameters<typeof createStandingIntentRaw>[0], "creatorSender">,
) {
  return createStandingIntentRaw({ ...params, creatorSender: "owner-sender" });
}

function parseToolJson(
  result: Awaited<ReturnType<ReturnType<typeof createStandingIntentTool>["execute"]>>,
) {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text ?? "null") as Record<string, unknown>;
}

describe("standing intents", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-standing-intents-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
      recursive: true,
    });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("lazy-ensures the additive table idempotently", () => {
    const first = createStandingIntent({
      agentId: "main",
      description: "Mention the launch checklist.",
      triggerKeywords: ["launch checklist"],
      nowMs: 1_000,
    });
    const second = createStandingIntent({
      agentId: "main",
      description: "Mention the rollback owner.",
      triggerKeywords: ["rollback owner"],
      nowMs: 2_000,
    });

    expect(first.id).not.toBe(second.id);
    expect(listStandingIntents({ agentId: "main", nowMs: 2_000 })).toHaveLength(2);
  });

  it("creates, lists, and explicitly cancels through the agent tool", async () => {
    const tool = createStandingIntentTool({
      agentId: "main",
      sourceSessionId: "session-1",
      conversationId: "qa-dm-5",
      provider: "qa-channel",
      senderId: "alice",
    });
    const createResult = parseToolJson(
      await tool.execute("call-1", {
        action: "create",
        description: "Ask whether the migration was rehearsed.",
        triggerKeywords: ["migration", "rehearsal"],
      }),
    );
    const created = createResult.intent as {
      id: string;
      channelScope: string | null;
      senderScope: string | null;
      status: string;
    };
    expect(created).toMatchObject({
      channelScope: "qa-channel",
      senderScope: "alice",
      creatorSender: "alice",
      status: "armed",
    });
    expect(createResult.message).toBe(
      "Intent is armed for this channel. The system injects the reminder automatically when it triggers. Do not deliver it early or cancel it unless the user asks.",
    );
    expect(tool.description).toContain("system injects the reminder automatically");
    expect(tool.description).toContain("Use scheduled tasks for time-based reminders");
    expect(tool.description).not.toMatch(/\b(?:cron|automations)\b/u);
    expect(tool.description).toContain(
      'Use "channel" (the default) for any "whenever I mention X" request.',
    );
    expect(tool.description).toContain(
      'Use "conversation" only when the user explicitly limits the reminder to the current thread.',
    );
    const listResult = parseToolJson(await tool.execute("call-2", { action: "list" }));
    const listed = listResult.intents as Array<{ id: string; sourceSessionId: string }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, sourceSessionId: "session-1" });

    const cancelResult = parseToolJson(
      await tool.execute("call-3", { action: "cancel", id: created.id }),
    );
    expect(cancelResult.cancelled).toBe(true);
    expect(cancelStandingIntent({ agentId: "main", id: created.id })).toBeNull();
  });

  it("injects owner-created intents and skips rows without a known creator", async () => {
    const tool = createStandingIntentTool({
      agentId: "main",
      conversationId: "qa-dm-5",
      provider: "qa-channel",
      senderId: "owner-1",
    });
    const created = parseToolJson(
      await tool.execute("create-owner-intent", {
        action: "create",
        description: "Use the owner-authored reminder.",
        triggerKeywords: ["owner signal"],
      }),
    ).intent as { id: string };
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "owner signal",
        channel: "qa-dm-5",
        provider: "qa-channel",
        senderId: "owner-1",
        nowMs: Date.now(),
      }).map((intent) => intent.id),
    ).toEqual([created.id]);

    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const insertUnknownCreator = db.prepare(
      `INSERT INTO standing_intents (
        id, description, trigger_keywords, trigger_embedding, channel_scope, sender_scope,
        creator_sender, status, expires_at, max_fires, fire_count, cooldown_seconds,
        last_fired_at, created_at, source_session_id
      ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'armed', ?, 1, 0, 0, NULL, ?, NULL)`,
    );
    const expiresAt = Date.now() + 60_000;
    insertUnknownCreator.run(
      "missing-creator",
      "Missing creator must not inject.",
      JSON.stringify(["missing creator signal"]),
      null,
      expiresAt,
      Date.now(),
    );
    insertUnknownCreator.run(
      "unknown-creator",
      "Unknown creator must not inject.",
      JSON.stringify(["unknown creator signal"]),
      "unknown",
      expiresAt,
      Date.now(),
    );

    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "missing creator signal and unknown creator signal",
        nowMs: Date.now(),
      }),
    ).toEqual([]);
  });

  it("derives typed conversation, channel, anywhere, sender, and anyone scopes", async () => {
    const tool = createStandingIntentTool({
      agentId: "main",
      conversationId: "QA-DM-5",
      provider: "QA-CHANNEL",
      senderId: "alice",
    });
    const schema = tool.parameters as {
      properties?: Record<string, { enum?: string[]; default?: string }>;
    };
    expect(schema.properties?.channelScope).toBeUndefined();
    expect(schema.properties?.scope).toMatchObject({
      type: "string",
      enum: ["conversation", "channel", "anywhere"],
      default: "channel",
    });
    expect(schema.properties?.senderScope?.enum).toEqual(["sender", "anyone"]);

    const conversationResult = parseToolJson(
      await tool.execute("call-conversation", {
        action: "create",
        description: "Use the conversation reminder.",
        triggerKeywords: ["conversation reminder"],
        scope: "conversation",
        senderScope: "anyone",
      }),
    );
    expect(conversationResult.intent).toMatchObject({
      channelScope: "QA-DM-5",
      senderScope: null,
    });
    expect(conversationResult.message).toContain("Intent is armed for this conversation.");
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "conversation reminder",
        channel: "QA-DM-5",
        provider: "qa-channel",
        senderId: "bob",
      }),
    ).toHaveLength(1);

    const anywhereResult = parseToolJson(
      await tool.execute("call-anywhere", {
        action: "create",
        description: "Use the global reminder.",
        triggerKeywords: ["global reminder"],
        scope: "anywhere",
      }),
    );
    expect(anywhereResult.intent).toMatchObject({
      channelScope: null,
      senderScope: "alice",
    });
    expect(anywhereResult.message).toContain("Intent is armed everywhere.");
  });

  it("refuses senderless creation instead of exposing it to unrelated channel users", async () => {
    const tool = createStandingIntentTool({ agentId: "main" });

    expect(parseToolJson(await tool.execute("list-empty", { action: "list" }))).toEqual({
      intents: [],
    });
    await expect(
      tool.execute("create-default", {
        action: "create",
        description: "Identity-free reminder.",
        triggerKeywords: ["identity free"],
      }),
    ).rejects.toThrow("authenticated channel and sender identity is unavailable");

    expect(listStandingIntents({ agentId: "main" })).toEqual([]);
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "identity free",
        provider: "qa-channel",
        channel: "unrelated-room",
        senderId: "unrelated-user",
      }),
    ).toEqual([]);
  });

  it("applies scope, cooldown, fire-budget, and expiry transitions", () => {
    const created = createStandingIntent({
      agentId: "main",
      description: "Surface the review checklist.",
      triggerKeywords: ["review checklist"],
      channelScope: encodeStandingIntentChannelScope({ scope: "channel", provider: "slack" }),
      senderScope: encodeStandingIntentSenderScope({ provider: "slack", senderId: "alice" }),
      maxFires: 2,
      cooldownSeconds: 60,
      expiresAt: 200_000,
      nowMs: 1_000,
    });

    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "Can we review the checklist?",
        channel: "qa-dm-5",
        provider: "discord",
        senderId: "alice",
        nowMs: 2_000,
      }),
    ).toStrictEqual([]);

    const first = matchStandingIntents({
      agentId: "main",
      prompt: "Can we review the checklist?",
      channel: "qa-dm-5",
      provider: "slack",
      senderId: "alice",
      nowMs: 2_000,
    });
    expect(first[0]).toMatchObject({ id: created.id, status: "fired", fireCount: 1 });
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "Review checklist again",
        channel: "qa-dm-5",
        provider: "slack",
        senderId: "alice",
        nowMs: 61_999,
      }),
    ).toStrictEqual([]);

    const second = matchStandingIntents({
      agentId: "main",
      prompt: "Review checklist again",
      channel: "qa-dm-5",
      provider: "slack",
      senderId: "alice",
      nowMs: 62_000,
    });
    expect(second[0]).toMatchObject({ id: created.id, status: "done", fireCount: 2 });
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "Review checklist once more",
        channel: "qa-dm-5",
        provider: "slack",
        senderId: "alice",
        nowMs: 130_000,
      }),
    ).toStrictEqual([]);

    createStandingIntent({
      agentId: "main",
      description: "Expired intent.",
      triggerKeywords: ["expired signal"],
      expiresAt: 150_000,
      nowMs: 1_000,
    });
    sweepStandingIntents({ agentId: "main", nowMs: 150_000 });
    expect(
      listStandingIntents({ agentId: "main", status: "expired", nowMs: 150_000 }),
    ).toHaveLength(1);
  });

  it("keeps provider, conversation, sender, and account identities namespaced", () => {
    createStandingIntent({
      agentId: "main",
      description: "Account-scoped reminder.",
      triggerKeywords: ["account reminder"],
      channelScope: encodeStandingIntentChannelScope({
        scope: "conversation",
        provider: "slack",
        accountId: "work",
        conversationId: "slack",
      }),
      senderScope: encodeStandingIntentSenderScope({
        provider: "slack",
        accountId: "work",
        senderId: "alice",
      }),
      maxFires: 1,
      nowMs: 1_000,
    });

    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "other-room",
        provider: "slack",
        accountId: "work",
        senderId: "alice",
        nowMs: 2_000,
      }),
    ).toHaveLength(0);
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "slack",
        provider: "slack",
        accountId: "personal",
        senderId: "alice",
        nowMs: 3_000,
      }),
    ).toHaveLength(0);
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "slack",
        provider: "slack",
        accountId: "work",
        senderId: "alice",
        nowMs: 4_000,
      }),
    ).toHaveLength(1);
  });

  it("requires complete trigger phrases and supports one-character keywords", () => {
    createStandingIntent({
      agentId: "main",
      description: "Check the candidate owner.",
      triggerKeywords: ["release candidate"],
      maxFires: 1,
      nowMs: 1_000,
    });

    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "Please summarize the release notes.",
        nowMs: 2_000,
      }),
    ).toStrictEqual([]);
    expect(
      matchStandingIntents({
        agentId: "main",
        prompt: "The candidate release is ready.",
        nowMs: 3_000,
      }),
    ).toHaveLength(1);

    createStandingIntent({
      agentId: "main",
      description: "Handle the X project.",
      triggerKeywords: ["x"],
      maxFires: 1,
      nowMs: 4_000,
    });
    expect(matchStandingIntents({ agentId: "main", prompt: "X", nowMs: 5_000 })).toHaveLength(1);

    createStandingIntent({
      agentId: "main",
      description: "Keep a multiline trigger intact.",
      triggerKeywords: ["alpha\nbeta"],
      maxFires: 1,
      nowMs: 6_000,
    });
    expect(
      matchStandingIntents({ agentId: "main", prompt: "alpha only", nowMs: 7_000 }),
    ).toStrictEqual([]);
    expect(
      matchStandingIntents({ agentId: "main", prompt: "alpha and beta", nowMs: 8_000 }),
    ).toHaveLength(1);
  });

  it("accepts chatId-only interactive contexts", () => {
    expect(
      isEligibleStandingIntentTurn({
        trigger: "user",
        sessionId: "session-1",
        messageProvider: "custom-channel",
        chatId: "room-1",
      }),
    ).toBe(true);
  });

  it("matches late prompt terms and does not let stale FTS rows starve an armed intent", () => {
    for (let index = 0; index < 33; index += 1) {
      const stale = createStandingIntent({
        agentId: "main",
        description: `Stale deployment intent ${index}.`,
        triggerKeywords: ["deployment"],
        nowMs: index,
      });
      cancelStandingIntent({ agentId: "main", id: stale.id });
      createStandingIntent({
        agentId: "main",
        description: `Phrase decoy ${index}.`,
        triggerKeywords: [`deployment decoy${index}`],
        nowMs: index,
      });
    }
    const active = createStandingIntent({
      agentId: "main",
      description: "Use the current deployment intent.",
      triggerKeywords: ["deployment needle"],
      maxFires: 1,
      nowMs: 100,
    });
    const prefix = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

    const matches = matchStandingIntents({
      agentId: "main",
      prompt: `${prefix} deployment needle`,
      nowMs: 1_000,
    });

    expect(matches.map((intent) => intent.id)).toStrictEqual([active.id]);
  });

  it("does not consume fire budgets for intents that do not fit hidden context", () => {
    const intents = Array.from({ length: 3 }, (_, index) =>
      createStandingIntent({
        agentId: "main",
        description: `${String(index)}${"x".repeat(499)}`,
        triggerKeywords: ["bounded trigger"],
        maxFires: 1,
        nowMs: index + 1,
      }),
    );

    const matches = matchStandingIntents({
      agentId: "main",
      prompt: "bounded trigger",
      nowMs: 10_000,
    });
    const stored = listStandingIntents({ agentId: "main", nowMs: 10_000 });

    expect(matches).toHaveLength(2);
    expect(buildStandingIntentContext(matches)?.length).toBeLessThanOrEqual(
      INTENT_INJECTION_MAX_CHARS,
    );
    expect(stored.find((intent) => intent.id === intents[2]?.id)).toMatchObject({
      status: "armed",
      fireCount: 0,
    });
  });

  it("uses anti-nagging defaults and bounds hidden injection", () => {
    const intent = createStandingIntent({
      agentId: "main",
      description: "x".repeat(500),
      triggerKeywords: ["bounded"],
      nowMs: 1_000,
    });

    expect(intent).toMatchObject({
      cooldownSeconds: DEFAULT_INTENT_COOLDOWN_SECONDS,
      maxFires: DEFAULT_INTENT_MAX_FIRES,
      expiresAt: 1_000 + DEFAULT_INTENT_EXPIRY_MS,
    });
    const context = buildStandingIntentContext([intent, intent, intent, intent]);
    expect(context).toContain("Standing intent (created 1970-01-01):");
    expect(context?.length).toBeLessThanOrEqual(INTENT_INJECTION_MAX_CHARS);
    expect(context?.match(/Standing intent/g)).toHaveLength(2);
  });
});
