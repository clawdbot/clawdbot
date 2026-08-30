import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createChannelOwnerProofFixture,
  readSourceFinalizationPrivateOptionsForTest,
} from "openclaw/plugin-sdk/matrix-source-finalization-test-fixtures";
import { afterAll, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { MatrixChannelConfigSchema } from "../../config-schema.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixSetupInput } from "../../setup-config.js";
import { matrixSetupAdapter } from "../../setup-core.js";
import type { CoreConfig, MatrixTurnTakingConfig } from "../../types.js";
import { MATRIX_PREVIEW_PROTOCOL_KEY } from "../preview-protocol.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { createMatrixTurnTakingCoordinator } from "./turn-taking-coordinator.js";
import { EventType, type MatrixRawEvent } from "./types.js";

const modelGateway = vi.hoisted(() => ({
  participation: "speak" as "speak" | "silent",
  nextStep: "send-as-is" as "redraft" | "discard" | "send-as-is",
  participationCalls: 0,
  participationRosters: [] as Array<{ eventId: string; accountIds: string[] }>,
  nextStepCalls: 0,
}));

const matrixConfigRuntimeSchema = MatrixChannelConfigSchema.runtime;
if (!matrixConfigRuntimeSchema) {
  throw new Error("expected Matrix runtime config schema");
}

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: vi.fn(async () => ({ model: {}, auth: {} })),
  completeWithPreparedSimpleCompletionModel: vi.fn(
    async (params: { context: { systemPrompt: string; messages: Array<{ content: string }> } }) => {
      if (params.context.systemPrompt.includes("participation controller")) {
        modelGateway.participationCalls += 1;
        const { untrustedRoomData } = JSON.parse(params.context.messages[0]!.content) as {
          untrustedRoomData: { eventId: string; candidates: Array<{ accountId: string }> };
        };
        modelGateway.participationRosters.push({
          eventId: untrustedRoomData.eventId,
          accountIds: untrustedRoomData.candidates.map(({ accountId }) => accountId),
        });
        return {
          text: JSON.stringify({
            decisions: untrustedRoomData.candidates.map(({ accountId }) => ({
              accountId,
              disposition:
                accountId === "alpha" && modelGateway.participation === "speak"
                  ? "strongly-speak"
                  : "strongly-silent",
            })),
          }),
        };
      }
      modelGateway.nextStepCalls += 1;
      return { text: JSON.stringify({ action: modelGateway.nextStep }) };
    },
  ),
  extractAssistantText: (value: { text?: string }) => value.text ?? "",
}));

type QueuedOwner = {
  deliver: (
    payload: { text: string },
    info: { kind: "final"; runId: string },
  ) => Promise<"delivered" | "cancelled">;
};

type ResolverOptions = {
  queuedSourceReplyDelivery?: QueuedOwner;
};

type TerminalSend = {
  roomId: string;
  body: string;
  wireType: "m.room.message" | "m.room.encrypted";
};

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

function config(turnTaking?: MatrixTurnTakingConfig): CoreConfig {
  return {
    agents: {
      list: [
        { id: "main", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    },
    bindings: [
      { agentId: "main", match: { channel: "matrix", accountId: "alpha" } },
      { agentId: "beta", match: { channel: "matrix", accountId: "beta" } },
    ],
    channels: {
      matrix: {
        groupPolicy: "open",
        groupAllowFrom: ["*"],
        groups: { "*": { requireMention: false } },
        ...(turnTaking ? { turnTaking } : {}),
        accounts: {
          alpha: {
            enabled: true,
            homeserver: "https://matrix.example.org",
            userId: "@alpha:example.org",
            accessToken: "test-alpha-token",
          },
          beta: {
            enabled: true,
            homeserver: "https://matrix.example.org",
            userId: "@beta:example.org",
            accessToken: "test-beta-token",
          },
        },
      },
    },
  } as CoreConfig;
}

function message(params: {
  eventId: string;
  body: string;
  mentioned?: boolean;
  sender?: string;
}): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    sender: params.sender ?? "@human:example.org",
    event_id: params.eventId,
    origin_server_ts: Date.now(),
    content: {
      msgtype: "m.text",
      body: params.body,
      ...(params.mentioned ? { "m.mentions": { user_ids: ["@alpha:example.org"] } } : {}),
    },
  } as MatrixRawEvent;
}

function enhancedFinalMessage(params: { eventId: string; body: string }): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    sender: "@beta:example.org",
    event_id: params.eventId,
    origin_server_ts: Date.now(),
    content: {
      msgtype: "m.text",
      body: params.body,
      [MATRIX_PREVIEW_PROTOCOL_KEY]: {
        v: 1,
        responseId: `response-${params.eventId}`,
        triggerEventId: `$trigger-${params.eventId}`,
        state: "final",
        revision: 0,
        kind: "answer",
        partIndex: 0,
        partCount: 1,
      },
    },
  } as MatrixRawEvent;
}

async function createHarness(params: {
  origin: "bundled" | "workspace";
  omitHostInbound?: boolean;
  turnTaking?: MatrixTurnTakingConfig;
  wireType?: "m.room.message" | "m.room.encrypted";
  requireMention?: boolean;
  resolver: (ctx: unknown, options?: ResolverOptions) => Promise<{ text: string } | undefined>;
}) {
  const cfg = config(params.turnTaking);
  const fixture = createChannelOwnerProofFixture({
    plugin: matrixPlugin,
    origin: params.origin,
    config: cfg as never,
  });
  const terminalSends: TerminalSend[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const wireType = params.wireType ?? "m.room.message";
  let sendIndex = 0;
  const createClient = (accountId: "alpha" | "beta") =>
    ({
      getUserId: async () => `@${accountId}:example.org`,
      getEvent: async () => undefined,
      getRelations: async () => ({ events: [] }),
      getJoinedRoomMembers: async () => [
        "@alpha:example.org",
        "@beta:example.org",
        "@human:example.org",
      ],
      getMessageWireEventType: async () => wireType,
      prepareRoomForMessageSend: async () => wireType,
      getTransactionScopeId: async () => `proof-device-${accountId}`,
      sendEvent: async () => `$event-${++sendIndex}`,
      sendMessage: async (roomId: string, content: { body?: string }) => {
        terminalSends.push({ roomId, body: content.body ?? "", wireType });
        return `$message-${++sendIndex}`;
      },
      sendReadReceipt: async () => undefined,
      setTyping: async () => undefined,
      redactEvent: async () => undefined,
    }) as unknown as MatrixClient;
  const clients = { alpha: createClient("alpha"), beta: createClient("beta") };

  const ownerInbound = fixture.channelRuntime.inbound;
  const proofRun = ((runParams: Parameters<typeof ownerInbound.run>[0]) =>
    ownerInbound.run({
      ...runParams,
      adapter: {
        ...runParams.adapter,
        resolveTurn: async (...args: Parameters<typeof runParams.adapter.resolveTurn>) => ({
          ...(await runParams.adapter.resolveTurn(...args)),
          replyResolver: params.resolver,
        }),
      },
    } as never)) as unknown as typeof ownerInbound.run;
  const proofChannelInbound = {
    buildContext: ownerInbound.buildContext,
    run: proofRun,
  };
  const proofRuntime = fixture.hostRuntime;
  setMatrixRuntime(proofRuntime as never);

  const coordinator = createMatrixTurnTakingCoordinator();
  for (const [accountId, userId] of [
    ["alpha", "@alpha:example.org"],
    ["beta", "@beta:example.org"],
  ] as const) {
    coordinator.registerMonitor({
      accountId,
      userId,
      homeserver: "https://matrix.example.org",
      client: clients[accountId],
      core: proofRuntime as never,
      log: (entry) => logs.push(entry),
    });
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pr113115-boundary-"));
  tempRoots.push(tempRoot);
  const roomsConfig = { "*": { requireMention: params.requireMention ?? false } };
  const createHandler = (accountId: "alpha" | "beta") =>
    createMatrixRoomMessageHandler({
      client: clients[accountId],
      core: proofRuntime as never,
      cfg,
      accountId,
      accountConfig: cfg.channels?.matrix?.accounts?.[accountId],
      runtime: {
        log: (entry: string) => logs.push(entry),
        error: (entry: string) => errors.push(entry),
        exit: () => undefined,
      } as never,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (entry: unknown) => errors.push(String(entry)),
        debug: () => undefined,
      },
      logVerboseMessage: (entry) => logs.push(entry),
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      roomsConfig,
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@alpha:example.org", "@beta:example.org"]),
      replyToMode: "off",
      threadReplies: "off",
      streaming: "off",
      previewToolProgressEnabled: false,
      blockStreamingEnabled: false,
      dmEnabled: true,
      dmPolicy: "open",
      mediaMaxBytes: 10_000_000,
      historyLimit: 0,
      startupMs: 0,
      startupGraceMs: 0,
      dropPreStartupMessages: false,
      directTracker: { isDirectMessage: async () => false },
      getRoomInfo: async () => ({ altAliases: [] }),
      getMemberDisplayName: async (_roomId, userId) => userId,
      needsRoomAliasesForConfig: false,
      turnTaking: params.turnTaking,
      turnTakingRoomsConfig: roomsConfig,
      needsRoomAliasesForTurnTakingConfig: false,
      turnTakingCoordinator: coordinator,
      ...(params.omitHostInbound ? {} : { channelInbound: proofChannelInbound }),
      resolveStorePath: () => path.join(tempRoot, accountId, "sessions.json"),
    });
  // Every registered monitor needs its real account handler to prepare receiver access.
  const handlers = { alpha: createHandler("alpha"), beta: createHandler("beta") };
  return {
    client: clients.alpha,
    coordinator,
    errors,
    fixture,
    handler: handlers.alpha,
    logs,
    terminalSends,
  };
}

describe("PR #113115 production owner and Matrix delivery boundary", () => {
  it("proves terminal delivery authority, freshness decisions, encrypted fallback, and config upgrades", async () => {
    const roomId = "!proof:example.org";
    const verdict: Record<string, unknown> = {
      syntheticSeams: ["external-model-gateway", "MatrixClient-homeserver-transport"],
      fixtureExposure: "openclaw/plugin-sdk/test-fixtures only",
      productionPath: [
        "Matrix-standalone-final-wire-event",
        "coordinator-membership-and-protocol-promotion",
        "bundled-plugin-registry-owner",
        "Matrix-room-handler",
        "core-channel-turn",
        "queued-source-delivery",
        "Matrix-reply-dispatcher",
        "sendMessageMatrix",
        "MatrixClient.sendMessage",
      ],
    };

    modelGateway.participation = "speak";
    let allowedOwner: QueuedOwner | undefined;
    const allowed = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 0 },
      resolver: async (_ctx, options) => {
        allowedOwner = options?.queuedSourceReplyDelivery;
        return undefined;
      },
    });
    await allowed.handler(
      roomId,
      enhancedFinalMessage({ eventId: "$allowed", body: "Alpha, take this." }),
    );
    expect(allowed.errors).toEqual([]);
    expect(modelGateway.participationRosters).toContainEqual({
      eventId: "$allowed",
      accountIds: ["alpha"],
    });
    expect(allowedOwner).toBeDefined();
    const allowedBefore = allowed.terminalSends.length;
    const allowedOutcome = await allowedOwner!.deliver(
      { text: "allowed late final" },
      { kind: "final", runId: "allowed-run" },
    );
    expect(allowedOutcome).toBe("delivered");
    expect(allowed.terminalSends.slice(allowedBefore).map((entry) => entry.body)).toEqual([
      "allowed late final",
    ]);
    verdict.allowedBundledOwner = {
      outcome: allowedOutcome,
      terminalSendDelta: allowed.terminalSends.length - allowedBefore,
    };
    allowed.fixture.retire();

    let forbiddenResolverCalls = 0;
    const forbidden = await createHarness({
      origin: "workspace",
      turnTaking: { enabled: true, redraftDepth: 0 },
      resolver: async () => {
        forbiddenResolverCalls += 1;
        return undefined;
      },
    });
    await forbidden.handler(
      roomId,
      enhancedFinalMessage({ eventId: "$forbidden", body: "Workspace owner attempt." }),
    );
    expect(forbiddenResolverCalls).toBe(0);
    expect(forbidden.errors).toEqual([
      "matrix handler failed: Error: Source-final freshness requires automatic delivery; message_tool_only cannot be used for this turn.",
    ]);
    expect(forbidden.terminalSends).toHaveLength(0);
    verdict.workspaceForbiddenOwner = {
      outcome: "rejected-before-model-and-transport",
      reason: "automatic-delivery-capability-missing",
      resolverCalls: forbiddenResolverCalls,
      terminalSendDelta: 0,
    };
    forbidden.fixture.retire();

    let omittedResolverCalls = 0;
    const omitted = await createHarness({
      origin: "bundled",
      omitHostInbound: true,
      turnTaking: { enabled: true, redraftDepth: 0 },
      resolver: async () => {
        omittedResolverCalls += 1;
        return undefined;
      },
    });
    await omitted.handler(
      roomId,
      enhancedFinalMessage({ eventId: "$omitted", body: "Missing host inbound runtime." }),
    );
    expect(omittedResolverCalls).toBe(0);
    expect(omitted.errors).toEqual([
      "matrix handler failed: Error: Source-final freshness requires automatic delivery; message_tool_only cannot be used for this turn.",
    ]);
    expect(omitted.terminalSends).toHaveLength(0);
    verdict.omittedHostInbound = {
      outcome: "rejected-before-model-and-transport",
      reason: "automatic-delivery-capability-missing",
      resolverCalls: omittedResolverCalls,
      terminalSendDelta: 0,
    };
    omitted.fixture.retire();

    let retiredOwner: QueuedOwner | undefined;
    const retired = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 0 },
      resolver: async (_ctx, options) => {
        retiredOwner = options?.queuedSourceReplyDelivery;
        return undefined;
      },
    });
    await retired.handler(
      roomId,
      enhancedFinalMessage({ eventId: "$retired", body: "Capture then retire." }),
    );
    expect(retiredOwner).toBeDefined();
    retired.fixture.retire();
    const retiredBefore = retired.terminalSends.length;
    const retiredOutcome = await retiredOwner!.deliver(
      { text: "retired late final" },
      { kind: "final", runId: "retired-run" },
    );
    expect(retiredOutcome).toBe("cancelled");
    expect(retired.terminalSends).toHaveLength(retiredBefore);
    verdict.retiredBundledOwner = { outcome: retiredOutcome, terminalSendDelta: 0 };

    let redraftInstruction = "";
    const redraftHarness: Awaited<ReturnType<typeof createHarness>> = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
      resolver: async (_ctx, options) => {
        modelGateway.participation = "silent";
        await redraftHarness.handler(
          roomId,
          message({ eventId: "$redraft-newer", body: "New context: use the revised answer." }),
        );
        modelGateway.participation = "speak";
        modelGateway.nextStep = "redraft";
        const finalization = readSourceFinalizationPrivateOptionsForTest(options);
        expect(finalization?.onBeforeAgentFinalize).toEqual(expect.any(Function));
        const decision = await finalization?.onBeforeAgentFinalize?.({
          runId: "redraft-run",
          sessionId: "redraft-session",
          sessionKey: "agent:main:matrix:channel:proof",
          provider: "proof",
          model: "proof-model",
          lastAssistantMessage: "original stale draft",
          revisionAttempt: 0,
        });
        expect(decision?.action).toBe("revise");
        if (decision?.action === "revise") {
          redraftInstruction = decision.instruction;
          await decision.onAccepted?.();
        }
        return { text: "revised final using newer context" };
      },
    });
    const redraftBefore = redraftHarness.terminalSends.length;
    await redraftHarness.handler(
      roomId,
      message({ eventId: "$redraft", body: "Draft an answer, Alpha." }),
    );
    expect(redraftHarness.errors).toEqual([]);
    expect(modelGateway.participationRosters).toContainEqual({
      eventId: "$redraft",
      accountIds: ["alpha", "beta"],
    });
    const redraftBodies = redraftHarness.terminalSends
      .slice(redraftBefore)
      .map((entry) => entry.body);
    expect(redraftInstruction).toContain("$redraft-newer");
    expect(redraftBodies).toEqual(["revised final using newer context"]);
    expect(redraftBodies).not.toContain("original stale draft");
    verdict.redraft = { terminalBodies: redraftBodies, newerEventSeen: true };
    redraftHarness.fixture.retire();

    let discardAction = "";
    const discardHarness: Awaited<ReturnType<typeof createHarness>> = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 1, nextStep: { decider: "ai" } },
      resolver: async (_ctx, options) => {
        modelGateway.participation = "silent";
        await discardHarness.handler(
          roomId,
          message({ eventId: "$discard-newer", body: "Stop; no answer is needed." }),
        );
        modelGateway.participation = "speak";
        modelGateway.nextStep = "discard";
        const finalization = readSourceFinalizationPrivateOptionsForTest(options);
        expect(finalization?.onBeforeAgentFinalize).toEqual(expect.any(Function));
        const decision = await finalization?.onBeforeAgentFinalize?.({
          runId: "discard-run",
          sessionId: "discard-session",
          sessionKey: "agent:main:matrix:channel:proof",
          provider: "proof",
          model: "proof-model",
          lastAssistantMessage: "draft that must be discarded",
          revisionAttempt: 0,
        });
        discardAction = decision?.action ?? "missing";
        if (decision?.action === "discard") {
          await decision.onAccepted?.();
        }
        return undefined;
      },
    });
    const discardBefore = discardHarness.terminalSends.length;
    await discardHarness.handler(
      roomId,
      message({ eventId: "$discard", body: "Prepare a reply, Alpha." }),
    );
    expect(discardAction).toBe("discard");
    expect(discardHarness.terminalSends).toHaveLength(discardBefore);
    verdict.discard = { action: discardAction, terminalSendDelta: 0 };
    discardHarness.fixture.retire();

    let encryptedNegativeResolverCalls = 0;
    const encryptedNegative = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 1 },
      wireType: "m.room.encrypted",
      requireMention: true,
      resolver: async () => {
        encryptedNegativeResolverCalls += 1;
        return { text: "must not send" };
      },
    });
    const participationBeforeEncryptedNegative = modelGateway.participationCalls;
    await encryptedNegative.handler(
      roomId,
      message({ eventId: "$encrypted-negative", body: "Unmentioned encrypted message." }),
    );
    expect(encryptedNegativeResolverCalls).toBe(0);
    expect(encryptedNegative.terminalSends).toHaveLength(0);
    expect(modelGateway.participationCalls).toBe(participationBeforeEncryptedNegative);
    verdict.encryptedNegativeFallback = {
      ordinaryMentionGate: true,
      terminalSendDelta: 0,
      utilityCalls: 0,
    };
    encryptedNegative.fixture.retire();

    let encryptedPositiveOptions: ResolverOptions | undefined;
    const encryptedPositive = await createHarness({
      origin: "bundled",
      turnTaking: { enabled: true, redraftDepth: 1 },
      wireType: "m.room.encrypted",
      requireMention: true,
      resolver: async (_ctx, options) => {
        encryptedPositiveOptions = options;
        return { text: "ordinary encrypted reply" };
      },
    });
    const participationBeforeEncryptedPositive = modelGateway.participationCalls;
    await encryptedPositive.handler(
      roomId,
      message({
        eventId: "$encrypted-positive",
        body: "@alpha:example.org, reply through ordinary fallback.",
        mentioned: true,
      }),
    );
    expect(encryptedPositive.terminalSends.map((entry) => entry.body)).toEqual([
      "ordinary encrypted reply",
    ]);
    expect(encryptedPositiveOptions?.queuedSourceReplyDelivery).toBeUndefined();
    expect(modelGateway.participationCalls).toBe(participationBeforeEncryptedPositive);
    verdict.encryptedPositiveFallback = {
      ordinaryReplyDelivered: true,
      automaticQueuedOwner: false,
      utilityCalls: 0,
    };
    encryptedPositive.fixture.retire();

    let freshOptions: ResolverOptions | undefined;
    const fresh = await createHarness({
      origin: "bundled",
      resolver: async (_ctx, options) => {
        freshOptions = options;
        return { text: "fresh omitted-config reply" };
      },
    });
    const participationBeforeFresh = modelGateway.participationCalls;
    await fresh.handler(
      roomId,
      message({ eventId: "$fresh", body: "Fresh install default path.", mentioned: true }),
    );
    expect(fresh.terminalSends.map((entry) => entry.body)).toEqual(["fresh omitted-config reply"]);
    expect(freshOptions?.queuedSourceReplyDelivery).toBeUndefined();
    expect(modelGateway.participationCalls).toBe(participationBeforeFresh);
    const freshParse = matrixConfigRuntimeSchema.safeParse({
      accounts: {
        alpha: {
          homeserver: "https://matrix.example.org",
          userId: "@alpha:example.org",
          accessToken: "redacted",
        },
      },
    });
    expect(freshParse.success).toBe(true);
    if (!freshParse.success) {
      throw new Error("fresh Matrix config fixture did not validate");
    }
    const freshParsed = freshParse.data as { turnTaking?: unknown };
    expect(freshParsed.turnTaking).toBeUndefined();
    verdict.freshInstallOmission = {
      parsedTurnTaking: "omitted",
      ordinaryReplyDelivered: true,
      utilityCalls: 0,
    };
    fresh.fixture.retire();

    const upgraded = matrixSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@legacy:example.org",
            accessToken: "legacy-redacted",
            turnTaking: { enabled: true, redraftDepth: 2 },
            groups: { "!optout:example.org": { turnTaking: false } },
          },
        },
      } as CoreConfig,
      accountId: "ops",
      input: {
        name: "Ops",
        homeserver: "https://matrix.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-redacted",
      } as MatrixSetupInput,
    }) as CoreConfig;
    expect(upgraded.channels?.matrix?.turnTaking).toEqual({ enabled: true, redraftDepth: 2 });
    expect(upgraded.channels?.matrix?.groups?.["!optout:example.org"]?.turnTaking).toBe(false);
    expect(upgraded.channels?.matrix?.accounts?.default).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@legacy:example.org",
    });
    expect(upgraded.channels?.matrix?.accounts?.ops).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
    });
    expect(upgraded.channels?.matrix?.accounts?.default).not.toHaveProperty("turnTaking");
    expect(upgraded.channels?.matrix?.accounts?.ops).not.toHaveProperty("turnTaking");
    expect(matrixConfigRuntimeSchema.safeParse(upgraded.channels?.matrix).success).toBe(true);
    verdict.namedAccountUpgrade = {
      legacyCredentialsPromoted: true,
      namedCredentialsAdded: true,
      channelWideTurnTakingPreserved: true,
      roomOptOutPreserved: true,
      accountOverridesAbsent: true,
      schemaValid: true,
    };

    console.info(`PR113115_PRODUCTION_BOUNDARY_VERDICT ${JSON.stringify(verdict)}`);
  }, 30_000);
});
