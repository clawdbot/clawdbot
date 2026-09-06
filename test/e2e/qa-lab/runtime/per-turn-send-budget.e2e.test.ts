import { randomUUID } from "node:crypto";
// Real-behavior proof for the per-turn per-target send budget (PR #120491).
//
// Boots a real ephemeral Gateway child (mock-openai provider + qa-channel synthetic
// transport) and exercises the shared per-turn send ledger at the real delivery
// boundary — the Gateway plus the qa-channel outbound bus — rather than by stubbing
// callGateway.
//
// Two seams are used, each the tightest one that exposes the behavior:
//   * A real scripted agent turn (inbound -> mock model emits several `message`
//     sends in one run -> qa-channel delivery) proves the soft nudge counts only
//     confirmed deliveries. The ledger keys on the agent run, so this is the only
//     way to observe it end to end. The nudge text is read from the tool result the
//     runtime fed back to the model (the mock provider's request log).
//   * conversations_send has an owner-gated tool and returns a Code-Mode-only
//     structured `details` object that is not serialized to the model, bus, or
//     chat.history. To assert its schema-valid suppressed shape and idempotent
//     replay we run the real conversations_send tool in-process with a controlled
//     runId, while its callGateway is forwarded to the running Gateway child so the
//     delivery itself is real (Gateway conversations.send -> qa-channel bus). This
//     is not a stub: the result and the delivery come from the real Gateway.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Value } from "typebox/value";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { ConversationSendResultSchema } from "../../../../packages/gateway-protocol/src/schema/agent.js";
import { createConversationsSendTool } from "../../../../src/agents/tools/conversation-tools.js";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  peekTurnSendCount,
  resetTurnSendLedgerForTest,
} from "../../../../src/agents/tools/turn-send-ledger.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const PRIMARY_MODEL = "mock-openai/gpt-5.6-luna";
const ALTERNATE_MODEL = "mock-openai/gpt-5.6-luna-alt";
const SCENARIO_TIMEOUT_MS = 120_000;

type BusState = ReturnType<typeof createQaBusState>;
type BusServer = Awaited<ReturnType<typeof startQaBusServer>>;
type LiveGatewayOwner = ReturnType<typeof createQaLiveLaneGateway>;
type LiveHarness = Awaited<ReturnType<LiveGatewayOwner["start"]>>;

type OutboundMessage = {
  direction: string;
  text: string;
  deleted?: boolean;
  conversation: { id: string; kind: string };
};

type ScenarioVerdict = {
  scenario: string;
  deliveriesRecorded: number;
  toolResults: Array<{ status: string; noticePresent: boolean; schemaValid: boolean }>;
  ledgerCounts: Record<string, number>;
  pass: boolean;
};

const verdict: { pass: boolean; scenarios: ScenarioVerdict[] } = { pass: false, scenarios: [] };

function buildQaChannelTransport() {
  return {
    requiredPluginIds: ["qa-channel"] as const,
    createGatewayConfig: ({ baseUrl }: { baseUrl: string }) => ({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        visibleReplies: "automatic" as const,
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic" as const,
        },
      },
    }),
  };
}

let bus: BusServer | undefined;
let state: BusState | undefined;
let gatewayOwner: LiveGatewayOwner | undefined;
let harness: LiveHarness | undefined;

// Route visible replies through the message tool (sourceReplyDeliveryMode
// "message_tool_only"). In embedded mode that is what makes the `message` tool
// present in the turn (openclaw-tools.ts includeMessageTool); "automatic" omits it.
function withMessageToolReplies(cfg: Record<string, unknown>): Record<string, unknown> {
  const messages = (cfg.messages as Record<string, unknown> | undefined) ?? {};
  const groupChat = (messages.groupChat as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    messages: {
      ...messages,
      visibleReplies: "message_tool",
      groupChat: { ...groupChat, visibleReplies: "message_tool" },
    },
  };
}

// message-tool replies plus the opt-in per-turn hard cap (one send per target per
// turn). Used by the repeat scenario so a model-repeated `message` send is
// cap-blocked at the second copy.
function withCappedMessageToolReplies(cfg: Record<string, unknown>): Record<string, unknown> {
  const withReplies = withMessageToolReplies(cfg);
  const tools = (withReplies.tools as Record<string, unknown> | undefined) ?? {};
  const message = (tools.message as Record<string, unknown> | undefined) ?? {};
  return {
    ...withReplies,
    tools: { ...tools, message: { ...message, maxMessagesPerTurnPerTarget: 1 } },
  };
}

async function bootHarness(
  mutateConfig?: (cfg: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ state: BusState; harness: LiveHarness }> {
  resetTurnSendLedgerForTest();
  state = createQaBusState();
  bus = await startQaBusServer({ state });
  gatewayOwner = createQaLiveLaneGateway();
  harness = await gatewayOwner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: PRIMARY_MODEL,
    alternateModel: ALTERNATE_MODEL,
    transport: buildQaChannelTransport(),
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    ...(mutateConfig ? { mutateConfig: mutateConfig as never } : {}),
  });
  return { state, harness };
}

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
  }
  await bus?.stop().catch(() => undefined);
  harness = undefined;
  gatewayOwner = undefined;
  bus = undefined;
  state = undefined;
  resetTurnSendLedgerForTest();
});

afterAll(async () => {
  const outPath =
    process.env.OPENCLAW_PROOF_OUT?.trim() ||
    path.resolve(process.cwd(), ".artifacts/per-turn-send-budget-proof.json");
  verdict.pass = verdict.scenarios.length > 0 && verdict.scenarios.every((entry) => entry.pass);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
});

function outboundMessages(busState: BusState): OutboundMessage[] {
  return (busState.getSnapshot().messages as OutboundMessage[]).filter(
    (message) => message.direction === "outbound" && !message.deleted,
  );
}

async function waitForOutboundText(
  busState: BusState,
  predicate: (message: OutboundMessage) => boolean,
  timeoutMs = 60_000,
): Promise<OutboundMessage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = outboundMessages(busState).find(predicate);
    if (match) {
      return match;
    }
    await sleep(200);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for outbound; saw: ${JSON.stringify(
      outboundMessages(busState).map((message) => message.text),
    )}`,
  );
}

async function fetchMockRequestTexts(mockBaseUrl: string): Promise<string[]> {
  const response = await fetch(`${mockBaseUrl}/debug/requests`);
  const requests = (await response.json()) as Array<{
    allInputText?: unknown;
    toolOutput?: unknown;
  }>;
  return requests.flatMap((request) =>
    [request.allInputText, request.toolOutput].filter(
      (value): value is string => typeof value === "string",
    ),
  );
}

type MockRequestSnapshot = {
  body?: { input?: unknown };
  plannedToolCallId?: unknown;
};

async function fetchMockRequests(mockBaseUrl: string): Promise<MockRequestSnapshot[]> {
  const response = await fetch(`${mockBaseUrl}/debug/requests`);
  return (await response.json()) as MockRequestSnapshot[];
}

function inputItemsOf(request: MockRequestSnapshot): Record<string, unknown>[] {
  const input = request.body?.input;
  return Array.isArray(input)
    ? input.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
      )
    : [];
}

// Every function_call_output payload string across the recorded transcript requests.
// A suppressed message result is fed back to the model as one of these.
function collectToolOutputs(requests: MockRequestSnapshot[]): string[] {
  const outputs: string[] = [];
  for (const request of requests) {
    for (const item of inputItemsOf(request)) {
      if (item.type === "function_call_output" && typeof item.output === "string") {
        outputs.push(item.output);
      }
    }
  }
  return outputs;
}

async function waitForMockRequestText(
  mockBaseUrl: string,
  predicate: (text: string) => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await fetchMockRequestTexts(mockBaseUrl)).some(predicate)) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a matching mock request text`);
}

// One registry row read back from the running Gateway (conversations.list). Its
// (channel, account, target) route is fed to the tool's in-process resolveConversation
// so the per-turn ledger keys on the exact route the Gateway itself delivers to.
type LiveConversation = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: "direct" | "group" | "channel";
  target: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

// Forwards the tool's callGateway dependency to the running Gateway child so
// conversations.send performs a real Gateway delivery (Gateway -> qa-channel bus). The
// tool only reads opts.method/params/timeoutMs, so this narrow forward is faithful and
// NOT a stub: both the result and the delivery come from the real Gateway.
function createLiveCallGateway(live: LiveHarness) {
  return (async (opts: { method: string; params?: unknown; timeoutMs?: number | null }) =>
    await live.gateway.call(opts.method, opts.params, {
      timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20_000,
    })) as never;
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .join("\n");
}

// Reads the exact (channel, account, target) route for the qa-operator DM back from the
// running Gateway registry via conversations.list. The conversation is registered the
// first time an inbound turn to qa-operator is processed, so any scenario that has already
// driven such a turn can read it without minting another.
async function readQaOperatorConversation(live: LiveHarness): Promise<LiveConversation> {
  const startedAt = Date.now();
  let lastListed: LiveConversation[] = [];
  while (Date.now() - startedAt < 30_000) {
    const listed = (await live.gateway.call(
      "conversations.list",
      { agentId: "qa", limit: 50 },
      { timeoutMs: 10_000 },
    )) as { conversations: LiveConversation[] };
    lastListed = listed.conversations;
    const direct = lastListed.find(
      (entry) => entry.kind === "direct" && entry.target.includes("qa-operator"),
    );
    if (direct) {
      return direct;
    }
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for the qa-operator conversation to register; saw: ${JSON.stringify(
      lastListed,
    )}`,
  );
}

// Registers a qa-channel DM conversation in the "qa" agent's registry by running one
// real inbound turn (the model's "Reply exactly:" echo confirms the turn landed), then
// reads the exact (channel, account, target) route back from the Gateway registry. The
// reply marker is distinct from the send markers so it never pollutes the per-scenario
// delivery count.
async function registerQaConversation(
  live: LiveHarness,
  busState: BusState,
  replyMarker: string,
): Promise<LiveConversation> {
  busState.addInboundMessage({
    conversation: { id: "qa-operator", kind: "direct" },
    senderId: "qa-user",
    senderName: "QA User",
    text: `Register conversation. Reply exactly: ${replyMarker}`,
  });
  await waitForOutboundText(busState, (message) => message.text.includes(replyMarker));
  return await readQaOperatorConversation(live);
}

// Positive-control marker on the in-process conversations_send lane: a fresh turn (new
// session + runId, no cap) that really delivers `markerText` through the running Gateway
// to `conversation` (Gateway conversations.send -> qa-channel bus, exactly the lane the
// scenarios deliver on). The no-delivery fences drive one of these to prove the lane is
// live and has flushed past the point of interest.
function deliverConversationMarker(
  live: LiveHarness,
  conversation: LiveConversation,
  markerText: string,
): () => Promise<unknown> {
  return async () => {
    const tool = createConversationsSendTool(
      {
        agentId: "qa",
        agentSessionKey: `qa-fence-${randomUUID()}`,
        runId: `run-fence-${randomUUID()}`,
        config: {} as never,
      },
      {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      },
    );
    return await tool.execute(
      `fence-${randomUUID()}`,
      { conversationRef: conversation.conversationRef, message: markerText },
      undefined,
    );
  };
}

// Deterministic no-delivery barrier. A fixed `sleep` can only SAMPLE the outbound bus at
// one instant; it can never prove a send is absent, because a slow delivery could always
// land just after the sample. Instead we fence: capture the bus event cursor at the point
// of interest (after the action under test has fully settled), drive a positive-control
// marker delivery on the SAME outbound lane, then event-wait until the cursor advances
// strictly past the fence WITH the marker present. Once the marker is on the bus the lane
// has provably processed every event through the fence, so a send that was refused or
// suppressed before it would already be visible if it were ever going to land. The caller
// then asserts zero matches over that provably-complete window — a real negative, not a
// timed guess.
async function settleOutboundPastFence(
  busState: BusState,
  marker: { deliver: () => Promise<unknown>; matches: (message: OutboundMessage) => boolean },
  timeoutMs = 30_000,
): Promise<void> {
  const fenceCursor = busState.getSnapshot().cursor;
  await marker.deliver();
  await busState.waitForCursorAdvance(fenceCursor, timeoutMs, (snapshot) =>
    (snapshot.messages as OutboundMessage[]).some(
      (message) => message.direction === "outbound" && !message.deleted && marker.matches(message),
    ),
  );
}

describe("per-turn per-target send budget (real Gateway + qa-channel)", () => {
  it(
    "sanity: a plain qa-channel DM turn delivers one outbound reply",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState } = await bootHarness();
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Reply exactly: SANITY-OK",
      });
      const reply = await waitForOutboundText(busState, (message) =>
        message.text.includes("SANITY-OK"),
      );
      expect(reply.conversation.id).toBe("qa-operator");
    },
  );

  it(
    "scenario 1: second confirmed message send in one turn nudges and both deliveries land",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // message_tool mode maps to sourceReplyDeliveryMode "message_tool_only", the only
      // embedded configuration that admits the `message` tool into the turn's toolset
      // (openclaw-tools.ts includeMessageTool). Without it the model has no message tool
      // to call, so the send-budget fixture cannot fan out. Visible replies then flow
      // through message(action=send) to the current source, which is exactly the real
      // path the per-turn budget guards.
      const { state: busState, harness: live } = await bootHarness(withMessageToolReplies);
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Per-turn budget check. QA-PTSB-SEND tool=message count=2 marker=SBM",
      });
      // Both explicit tool sends must reach the peer on the bus.
      const first = await waitForOutboundText(busState, (message) => message.text === "SBM-1");
      const second = await waitForOutboundText(busState, (message) => message.text === "SBM-2");
      expect(first.conversation.id).toBe("qa-operator");
      expect(second.conversation.id).toBe("qa-operator");

      const sendDeliveries = outboundMessages(busState).filter((message) =>
        /^SBM-\d+$/u.test(message.text),
      );
      expect(sendDeliveries.map((message) => message.text).toSorted()).toEqual(["SBM-1", "SBM-2"]);

      // The runtime feeds the soft nudge back to the model on the 2nd send; read it from
      // the mock provider's recorded requests (the actual model-facing tool result).
      const mockTexts = await fetchMockRequestTexts(live.mock!.baseUrl);
      const noticePresent = mockTexts.some((text) =>
        text.includes("already sent 2 messages to this target this turn"),
      );
      expect(noticePresent).toBe(true);

      verdict.scenarios.push({
        scenario: "message soft nudge counts confirmed deliveries",
        deliveriesRecorded: sendDeliveries.length,
        toolResults: [
          { status: "sent", noticePresent: false, schemaValid: true },
          { status: "sent", noticePresent, schemaValid: true },
        ],
        ledgerCounts: { "qa-channel:qa-operator": sendDeliveries.length },
        pass: sendDeliveries.length === 2 && noticePresent,
      });
    },
  );

  it(
    "scenario 2: hard cap returns a schema-valid suppressed conversations_send result",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-2");

      const agentSessionKey = `qa-per-turn-budget-2-${randomUUID()}`;
      const ledgerSessionKey = buildTurnSendLedgerSessionKey("qa", agentSessionKey)!;
      const runId = `run-scenario-2-${randomUUID()}`;
      // Opt in to the per-turn hard cap for the message toolset (shared by conversations_send).
      const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never;
      const deps = {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      };
      const tool = createConversationsSendTool(
        { agentId: "qa", agentSessionKey, runId, config },
        deps,
      );

      // First send: below the cap -> real Gateway delivery to the qa-channel bus, status "sent".
      const firstResult = await tool.execute(
        "s2-A",
        { conversationRef: conversation.conversationRef, message: "S2-CAP-ALPHA" },
        undefined,
      );
      const firstDetails = firstResult.details as { status: string };
      const firstSchemaValid = Value.Check(ConversationSendResultSchema, firstResult.details);
      const firstNotice = toolResultText(firstResult).includes("already sent");
      expect(firstDetails.status).toBe("sent");
      expect(firstSchemaValid).toBe(true);
      expect(firstNotice).toBe(false);
      await waitForOutboundText(busState, (message) => message.text.includes("S2-CAP-ALPHA"));

      // Second send to the SAME conversation this turn with a NEW toolCallId (a distinct
      // operationId, not an idempotent replay): the pre-Gateway hard cap fires and returns a
      // schema-valid suppressed result carrying only status/conversationRef/channel, with the
      // human-readable block reason in the text content (never in details).
      const secondResult = await tool.execute(
        "s2-B",
        { conversationRef: conversation.conversationRef, message: "S2-CAP-BETA" },
        undefined,
      );
      const secondSchemaValid = Value.Check(ConversationSendResultSchema, secondResult.details);
      const secondText = toolResultText(secondResult);
      const secondNotice = secondText.includes("Blocked: already sent 1 message");
      expect(secondResult.details).toEqual({
        status: "suppressed",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
      });
      expect(secondSchemaValid).toBe(true);
      expect(secondNotice).toBe(true);

      // Only the first send reached the bus; the capped second never called the Gateway.
      // Fence the bus with a positive-control marker on the same conversation so the
      // absence of S2-CAP-BETA is proven over a provably-complete window, not sampled.
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "S2-FENCE-OK"),
        matches: (message) => message.text.includes("S2-FENCE-OK"),
      });
      const capDeliveries = outboundMessages(busState).filter(
        (message) => message.text.includes("S2-CAP-ALPHA") || message.text.includes("S2-CAP-BETA"),
      );
      expect(capDeliveries).toHaveLength(1);
      expect(capDeliveries[0]!.text).toContain("S2-CAP-ALPHA");

      const targetKey = buildTurnSendTargetKey({
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });
      const ledgerCount = peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey });
      expect(ledgerCount).toBe(1);

      verdict.scenarios.push({
        scenario: "hard cap returns schema-valid suppressed result",
        deliveriesRecorded: capDeliveries.length,
        toolResults: [
          {
            status: firstDetails.status,
            noticePresent: firstNotice,
            schemaValid: firstSchemaValid,
          },
          { status: "suppressed", noticePresent: secondNotice, schemaValid: secondSchemaValid },
        ],
        ledgerCounts: { "qa-channel:qa-operator": ledgerCount },
        pass:
          firstDetails.status === "sent" &&
          firstSchemaValid &&
          !firstNotice &&
          secondSchemaValid &&
          secondNotice &&
          capDeliveries.length === 1 &&
          ledgerCount === 1,
      });
    },
  );

  it(
    "scenario 3: a suppressed message send does not charge the per-turn budget",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // Drive the real message tool through the qa-lab directive (as scenario 1 does),
      // but interleave a suppressed send between two visible ones: outcomes=ok,suppress,ok.
      // The suppressed round sends an empty message, so real core delivery returns
      // deliveryStatus "suppressed" (no_visible_payload) and hits the exact
      // message-tool-execution.ts `deliveredNothing` branch at the real boundary. If that
      // send were counted, the second visible send (SBM3-3) would be the 3rd and nudge
      // "already sent 3 messages"; because it is not counted, SBM3-3 is the 2nd counted
      // send and nudges at 2. The "failed"/throwing branches of the same predicate are
      // covered at the message-tool seam in message-tool.test.ts ("does not count a
      // failed best-effort send" / "does not count a throwing send"); a real transport
      // failure is not producible through the qa-channel bus, which always accepts a
      // delivery.
      const { state: busState, harness: live } = await bootHarness(withMessageToolReplies);
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Per-turn budget check. QA-PTSB-SEND tool=message count=3 marker=SBM3 outcomes=ok,suppress,ok",
      });

      // Only the two visible sends reach the bus; the suppressed (empty) send never lands.
      const first = await waitForOutboundText(busState, (message) => message.text === "SBM3-1");
      const third = await waitForOutboundText(busState, (message) => message.text === "SBM3-3");
      expect(first.conversation.id).toBe("qa-operator");
      expect(third.conversation.id).toBe("qa-operator");

      const sendDeliveries = outboundMessages(busState).filter((message) =>
        /^SBM3-\d+$/u.test(message.text),
      );
      expect(sendDeliveries.map((message) => message.text).toSorted()).toEqual([
        "SBM3-1",
        "SBM3-3",
      ]);

      // The nudge fires on the 2nd COUNTED send. Because the suppressed send in between
      // did not charge the budget, the count is 2 (not 3) when SBM3-3 is delivered.
      const mockTexts = await fetchMockRequestTexts(live.mock!.baseUrl);
      const nudgeAtTwo = mockTexts.some((text) =>
        text.includes("already sent 2 messages to this target this turn"),
      );
      const nudgeAtThree = mockTexts.some((text) =>
        text.includes("already sent 3 messages to this target this turn"),
      );
      expect(nudgeAtTwo).toBe(true);
      expect(nudgeAtThree).toBe(false);

      verdict.scenarios.push({
        scenario: "suppressed send does not charge the per-turn budget",
        deliveriesRecorded: sendDeliveries.length,
        toolResults: [
          { status: "sent", noticePresent: false, schemaValid: true },
          { status: "suppressed", noticePresent: false, schemaValid: true },
          { status: "sent", noticePresent: nudgeAtTwo, schemaValid: true },
        ],
        ledgerCounts: { "qa-channel:qa-operator": sendDeliveries.length },
        pass: sendDeliveries.length === 2 && nudgeAtTwo && !nudgeAtThree,
      });
    },
  );

  it(
    "scenario 4: idempotent conversations_send replay does not re-deliver or double count",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-4");

      const agentSessionKey = `qa-per-turn-budget-4-${randomUUID()}`;
      const ledgerSessionKey = buildTurnSendLedgerSessionKey("qa", agentSessionKey)!;
      // Distinct turn from scenario 2 so no ledger slot leaks across scenarios.
      const runId = `run-scenario-4-${randomUUID()}`;
      // Cap of 1 proves the replay is admitted despite the hard cap being reached.
      const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never;
      const deps = {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      };
      const tool = createConversationsSendTool(
        { agentId: "qa", agentSessionKey, runId, config },
        deps,
      );
      const targetKey = buildTurnSendTargetKey({
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });

      // First send with toolCallId "rep-A" -> real Gateway delivery, ledger count 1.
      const first = await tool.execute(
        "rep-A",
        { conversationRef: conversation.conversationRef, message: "S4-REPLAY" },
        undefined,
      );
      const firstDetails = first.details as { status: string };
      const firstSchemaValid = Value.Check(ConversationSendResultSchema, first.details);
      expect(firstDetails.status).toBe("sent");
      await waitForOutboundText(busState, (message) => message.text.includes("S4-REPLAY"));
      expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);

      // Replay with the SAME toolCallId "rep-A" (same operationId). reserveTurnSend sees the
      // already-committed operationId and returns `replay`, admitting the call even though the
      // hard cap (1) is reached; the Gateway returns the completed operation as "sent" without
      // re-delivering, and the replay reservation is left unsettled so the count stays 1 and no
      // nudge fires.
      const replay = await tool.execute(
        "rep-A",
        { conversationRef: conversation.conversationRef, message: "S4-REPLAY" },
        undefined,
      );
      const replayDetails = replay.details as { status: string };
      const replaySchemaValid = Value.Check(ConversationSendResultSchema, replay.details);
      const replayText = toolResultText(replay);
      const replayNotice = replayText.includes("already sent");
      expect(replayDetails.status).toBe("sent");
      expect(replaySchemaValid).toBe(true);
      expect(replayNotice).toBe(false);

      // No re-delivery: fence the bus past a positive-control marker, then confirm the bus
      // still shows exactly one S4-REPLAY over that provably-complete window.
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "S4-FENCE-OK"),
        matches: (message) => message.text.includes("S4-FENCE-OK"),
      });
      const replayDeliveries = outboundMessages(busState).filter((message) =>
        message.text.includes("S4-REPLAY"),
      );
      expect(replayDeliveries).toHaveLength(1);

      // No double count: the ledger stays at one send for the turn.
      const ledgerCount = peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey });
      expect(ledgerCount).toBe(1);

      verdict.scenarios.push({
        scenario: "idempotent conversations_send replay does not re-deliver or double count",
        deliveriesRecorded: replayDeliveries.length,
        toolResults: [
          { status: firstDetails.status, noticePresent: false, schemaValid: firstSchemaValid },
          {
            status: replayDetails.status,
            noticePresent: replayNotice,
            schemaValid: replaySchemaValid,
          },
        ],
        ledgerCounts: { "qa-channel:qa-operator": ledgerCount },
        pass:
          firstDetails.status === "sent" &&
          firstSchemaValid &&
          replayDetails.status === "sent" &&
          replaySchemaValid &&
          !replayNotice &&
          replayDeliveries.length === 1 &&
          ledgerCount === 1,
      });
    },
  );

  it(
    "scenario 5: two concurrent distinct-op sends to one target admit exactly one under the cap",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // The core concurrency proof for #119992. Two conversations_send calls with DISTINCT
      // toolCallIds (distinct operationIds -> NOT an idempotent replay) fire at the same
      // conversation via Promise.all under maxMessagesPerTurnPerTarget:1. The old
      // peek->await->record path let both peek 0 and both deliver, blowing past the cap.
      // The reserve->settle primitive counts the first in-flight reservation toward the cap
      // synchronously, so the second call is exhausted before it reaches the Gateway:
      // exactly one delivery lands and the ledger commits exactly one send.
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-5");

      const agentSessionKey = `qa-per-turn-budget-5-${randomUUID()}`;
      const ledgerSessionKey = buildTurnSendLedgerSessionKey("qa", agentSessionKey)!;
      const runId = `run-scenario-5-${randomUUID()}`;
      const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never;
      const deps = {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      };
      const tool = createConversationsSendTool(
        { agentId: "qa", agentSessionKey, runId, config },
        deps,
      );

      // Distinct toolCallIds so the two calls derive distinct operationIds — a genuine
      // race, not a replay. Promise.all evaluates the array left-to-right, so the first
      // call reserves (synchronously, before its Gateway await) before the second runs.
      const results = await Promise.all([
        tool.execute(
          "s5-A",
          { conversationRef: conversation.conversationRef, message: "S5-CONC-ALPHA" },
          undefined,
        ),
        tool.execute(
          "s5-B",
          { conversationRef: conversation.conversationRef, message: "S5-CONC-BETA" },
          undefined,
        ),
      ]);

      const statusOf = (result: { details: unknown }) =>
        (result.details as { status?: string }).status;
      const sentResults = results.filter((result) => statusOf(result) === "sent");
      const suppressedResults = results.filter((result) => statusOf(result) === "suppressed");
      expect(sentResults).toHaveLength(1);
      expect(suppressedResults).toHaveLength(1);

      const sentResult = sentResults[0]!;
      const suppressedResult = suppressedResults[0]!;
      const sentSchemaValid = Value.Check(ConversationSendResultSchema, sentResult.details);
      const suppressedSchemaValid = Value.Check(
        ConversationSendResultSchema,
        suppressedResult.details,
      );
      const blockTextPresent = toolResultText(suppressedResult).includes(
        "Blocked: already sent 1 message",
      );
      expect(sentSchemaValid).toBe(true);
      expect(suppressedSchemaValid).toBe(true);
      expect(suppressedResult.details).toEqual({
        status: "suppressed",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
      });
      expect(blockTextPresent).toBe(true);

      // Exactly one of the two markers ever reaches the bus; the exhausted call never
      // called the Gateway, so its message is never delivered. Fence past a positive-control
      // marker so the "exactly one" holds over a provably-complete window.
      await waitForOutboundText(
        busState,
        (message) =>
          message.text.includes("S5-CONC-ALPHA") || message.text.includes("S5-CONC-BETA"),
      );
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "S5-FENCE-OK"),
        matches: (message) => message.text.includes("S5-FENCE-OK"),
      });
      const concurrentDeliveries = outboundMessages(busState).filter(
        (message) =>
          message.text.includes("S5-CONC-ALPHA") || message.text.includes("S5-CONC-BETA"),
      );
      expect(concurrentDeliveries).toHaveLength(1);

      const targetKey = buildTurnSendTargetKey({
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });
      const ledgerCount = peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey });
      expect(ledgerCount).toBe(1);

      verdict.scenarios.push({
        scenario: "two concurrent distinct-op sends admit exactly one under the cap",
        deliveriesRecorded: concurrentDeliveries.length,
        toolResults: [
          { status: "sent", noticePresent: false, schemaValid: sentSchemaValid },
          {
            status: "suppressed",
            noticePresent: blockTextPresent,
            schemaValid: suppressedSchemaValid,
          },
        ],
        ledgerCounts: { "qa-channel:qa-operator": ledgerCount },
        pass:
          sentSchemaValid &&
          suppressedSchemaValid &&
          blockTextPresent &&
          concurrentDeliveries.length === 1 &&
          ledgerCount === 1,
      });
    },
  );

  it(
    "scenario 6: two byte-identical direct message sends under the cap are cap-blocked (exactly-once delivery) — proves the cap-block path, NOT idempotent admission",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // The direct-tool counterpart to scenario 5's concurrency proof. The mock emits
      // the SAME `message` send TWICE in ONE model response — byte-identical arguments
      // (QA-PTSB-REPEAT), but each copy carrying a distinct call_id and item id. Distinct
      // ids are mandatory: the Responses transport's terminal guard rejects a stream that
      // repeats a tool-call identity, so byte-identical ids would throw before any dispatch
      // (zero delivery). With distinct ids the two copies pass the guard and, because the
      // message-tool idempotency key folds in the tool-call id, derive DIFFERENT keys
      // despite the identical payload — so the second copy is NOT recognized as an
      // idempotent replay and, under maxMessagesPerTurnPerTarget:1, is cap-blocked before
      // dispatch (reserveTurnSend exhaustion), exactly mirroring scenario 5's distinct
      // operationIds. On qa-channel (deliveryMode "direct") the delivery layer does not
      // dedup on the idempotency key, so admitting a replay here WOULD re-deliver;
      // exactly-once delivery is therefore the direct no-double-count proof (the real turn
      // runs in the Gateway child, whose per-turn ledger is not peekable from this process,
      // exactly as scenarios 1 and 3 treat it).
      const { state: busState, harness: live } = await bootHarness(withCappedMessageToolReplies);
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Per-turn budget check. QA-PTSB-REPEAT tool=message marker=SBR6",
      });

      // (a) Exactly one copy reaches the peer. Wait for the delivery, then confirm no
      // second SBR6 ever lands (a second admitted send would surface a second copy —
      // distinct idempotency keys are not deduped on this direct channel).
      const delivered = await waitForOutboundText(busState, (message) => message.text === "SBR6");
      expect(delivered.conversation.id).toBe("qa-operator");

      // (b) The second tool result is the schema-valid suppressed shape, fed back to the
      // model. Wait for it in the mock's recorded requests (the actual model-facing result).
      await waitForMockRequestText(live.mock!.baseUrl, (text) =>
        text.includes("turn_send_budget_exhausted"),
      );
      // The suppressed result was fed back to the model, so the second copy was
      // cap-blocked before dispatch and no second SBR6 can be in flight. Fence the bus on
      // the same conversation (its route is already registered by the turn above) so the
      // exactly-one assertion holds over a provably-complete window rather than a fixed
      // sample. A second admitted send would surface a second SBR6 before the marker lands.
      const conversation = await readQaOperatorConversation(live);
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "SBR6-FENCE-OK"),
        matches: (message) => message.text.includes("SBR6-FENCE-OK"),
      });
      const repeatDeliveries = outboundMessages(busState).filter(
        (message) => message.text === "SBR6",
      );
      expect(repeatDeliveries).toHaveLength(1);

      const requests = await fetchMockRequests(live.mock!.baseUrl);
      const suppressedOutput = collectToolOutputs(requests).find((output) =>
        output.includes("turn_send_budget_exhausted"),
      );
      expect(suppressedOutput).toBeDefined();
      const suppressedResult = JSON.parse(suppressedOutput!) as {
        status?: unknown;
        reason?: unknown;
        message?: unknown;
      };
      const suppressedSchemaValid =
        suppressedResult.status === "suppressed" &&
        suppressedResult.reason === "turn_send_budget_exhausted" &&
        typeof suppressedResult.message === "string" &&
        suppressedResult.message.includes("Blocked: already sent 1 message");
      expect(suppressedSchemaValid).toBe(true);

      // (c) The two executions carried DISTINCT tool-call ids with byte-identical
      // payloads. The emitting response planned a message send tagged ptsb_repeat
      // (plannedToolCallId records the first copy), and the first transcript round that
      // carries both message sends shows two distinct call_ids — the two distinct
      // idempotency keys that make the second copy a genuine send rather than a replay,
      // the direct-tool analogue of scenario 5's two distinct operationIds. (Counting
      // across all requests would over-count: later rounds re-encode the same two ids into
      // provider-sanitized variants.)
      const plannedRepeat = requests
        .map((request) => request.plannedToolCallId)
        .find((id): id is string => typeof id === "string" && id.includes("ptsb_repeat"));
      expect(plannedRepeat).toBeDefined();
      const messageIdsPerRequest = requests.map((request) =>
        inputItemsOf(request)
          .filter(
            (item) =>
              item.type === "function_call" &&
              item.name === "message" &&
              typeof item.call_id === "string",
          )
          .map((item) => item.call_id as string),
      );
      const firstRoundWithBothSends = messageIdsPerRequest.find((ids) => ids.length >= 2);
      expect(firstRoundWithBothSends).toBeDefined();
      const distinctExecutedIds = new Set(firstRoundWithBothSends);
      expect(distinctExecutedIds.size).toBe(2);

      verdict.scenarios.push({
        scenario:
          "direct message-tool byte-identical repeat under cap is cap-blocked (exactly-once delivery)",
        deliveriesRecorded: repeatDeliveries.length,
        toolResults: [
          { status: "sent", noticePresent: false, schemaValid: true },
          {
            status: "suppressed",
            noticePresent: suppressedSchemaValid,
            schemaValid: suppressedSchemaValid,
          },
        ],
        // Child-process ledger is not peekable here; exactly-one delivery is the
        // no-double-count proxy (a second admitted send would show 2 on this direct channel).
        ledgerCounts: { "qa-channel:qa-operator": repeatDeliveries.length },
        pass:
          repeatDeliveries.length === 1 && suppressedSchemaValid && distinctExecutedIds.size === 2,
      });
    },
  );

  it(
    "scenario 7: a spoofed attach-grant principal is refused before any delivery I/O (authority chain)",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // Authority-chain proof demanded by the ClawSweeper re-review, made discriminating by
      // an explicit pair on ONE qa-channel delivery lane against the SAME registered routable
      // target:
      //   (A) an authority-bound owner conversations_send delivers exactly once, proving the
      //       lane is live (real Gateway conversations.send -> qa-channel bus, as 2/4/5);
      //   (B) the real MCP loopback entry carrying a valid non-owner grant plus spoofed
      //       delivery-authority headers (routable target/channel/account/session) is refused
      //       BEFORE any delivery I/O and lands zero.
      // (A) runs first so its exactly-once delivery establishes liveness; that is what makes
      // (B)'s zero an authorization refusal rather than a dead harness. Every hop in (B) is the
      // genuine defense — validateMcpLoopbackRequest -> resolveAttachGrant ->
      // resolveMcpRequestContext (grant branch: spoofable headers forced to undefined) ->
      // owner-only tool deny — with no mocked resolver or gateway boundary. Both zero windows
      // are cursor-fenced past a positive-control marker, so an absent delivery is proven over a
      // provably-complete bus window, not sampled. Verdict entries carry no tokens.
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-7");

      // (A) Positive control FIRST: an authority-bound owner send to the legitimate routable
      // target delivers exactly once. Fence past a distinct marker so "exactly once" holds over
      // a complete window — a re-delivered duplicate would surface before the marker lands.
      const positiveSessionKey = `qa-per-turn-budget-7-${randomUUID()}`;
      const positiveRunId = `run-scenario-7-${randomUUID()}`;
      const positiveTool = createConversationsSendTool(
        {
          agentId: "qa",
          agentSessionKey: positiveSessionKey,
          runId: positiveRunId,
          config: {} as never,
        },
        {
          callGateway: createLiveCallGateway(live),
          resolveConversation: (() => conversation) as never,
        },
      );
      const positiveResult = await positiveTool.execute(
        "s7-pos",
        { conversationRef: conversation.conversationRef, message: "S7-POS-OK" },
        undefined,
      );
      const positiveStatus = (positiveResult.details as { status?: string }).status;
      expect(positiveStatus).toBe("sent");
      await waitForOutboundText(busState, (message) => message.text.includes("S7-POS-OK"));
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "S7-LIVE-OK"),
        matches: (message) => message.text.includes("S7-LIVE-OK"),
      });
      const positiveDeliveries = outboundMessages(busState).filter((message) =>
        message.text.includes("S7-POS-OK"),
      );
      expect(positiveDeliveries).toHaveLength(1);

      // (B) The forgery against the SAME registered target through the real MCP loopback entry:
      // a valid non-owner grant minted by the harness's own attach.grant.
      const grant = (await live.gateway.call(
        "attach.grant",
        { sessionKey: `qa-per-turn-budget-7-${randomUUID()}`, agentId: "qa" },
        { timeoutMs: 10_000 },
      )) as {
        token: string;
        mcpConfig: { mcpServers: { openclaw: { url: string } } };
      };
      const mcpUrl = grant.mcpConfig.mcpServers.openclaw.url;

      // The non-owner grant plus spoofed delivery-authority headers attempting to ride the
      // delivery owner toward the registered conversation.
      const spoofedHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${grant.token}`,
        "x-session-key": "agent:qa:SPOOFED-other-session",
        "x-openclaw-message-channel": conversation.channel,
        "x-openclaw-account-id": conversation.accountId,
        "x-openclaw-current-channel-id": conversation.channel,
        "x-openclaw-current-messaging-target": conversation.target,
      };

      // (B.1) tools/list through the real entry: the grant principal resolves non-owner, so
      // the owner-only conversations_send must not be advertised.
      const listResponse = await fetch(mcpUrl, {
        method: "POST",
        headers: spoofedHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(listResponse.status).toBe(200);
      const listed = (await listResponse.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const listedNames = (listed.result?.tools ?? []).map((tool) => tool.name);
      const conversationsSendHidden = !listedNames.includes("conversations_send");
      expect(conversationsSendHidden).toBe(true);

      // (B.2) tools/call conversations_send anyway (the forgery's end goal): it must be
      // refused, and — the authority-chain point — nothing may ever reach the bus.
      const callResponse = await fetch(mcpUrl, {
        method: "POST",
        headers: spoofedHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "conversations_send",
            arguments: { conversationRef: conversation.conversationRef, message: "S7-SPOOF" },
          },
        }),
      });
      const callBody = (await callResponse.json()) as {
        error?: { message?: string };
        result?: { isError?: boolean };
      };
      const refused =
        callResponse.status !== 200 ||
        callBody.error !== undefined ||
        callBody.result?.isError === true;
      expect(refused).toBe(true);

      // Cursor-fenced no-delivery window: a positive-control marker lands past the fence,
      // proving the lane processed everything through the refusal, so S7-SPOOF is absent over
      // a complete window rather than a 500ms sample. (A) already proved this lane delivers.
      await settleOutboundPastFence(busState, {
        deliver: deliverConversationMarker(live, conversation, "S7-SETTLED-OK"),
        matches: (message) => message.text.includes("S7-SETTLED-OK"),
      });
      const spoofedDeliveries = outboundMessages(busState).filter((message) =>
        message.text.includes("S7-SPOOF"),
      );
      expect(spoofedDeliveries).toHaveLength(0);

      verdict.scenarios.push({
        scenario: "spoofed attach-grant principal refused before delivery I/O (authority chain)",
        deliveriesRecorded: spoofedDeliveries.length,
        toolResults: [
          {
            status: positiveStatus ?? "unknown",
            noticePresent: false,
            schemaValid: positiveDeliveries.length === 1,
          },
          {
            status: "tools-list: conversations_send not advertised",
            noticePresent: false,
            schemaValid: conversationsSendHidden,
          },
          {
            status: refused ? "tools/call refused pre-delivery" : "tools/call NOT refused",
            noticePresent: false,
            schemaValid: refused,
          },
        ],
        ledgerCounts: { "qa-channel:qa-operator": positiveDeliveries.length },
        pass:
          conversationsSendHidden &&
          refused &&
          spoofedDeliveries.length === 0 &&
          positiveDeliveries.length === 1,
      });
    },
  );
});
