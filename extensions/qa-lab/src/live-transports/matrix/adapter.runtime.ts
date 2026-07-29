// Qa Lab plugin module implements Matrix live transport adapter behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { readQaScenarioExecutionConfig } from "../../scenario-catalog.js";
import { createMatrixQaScenarioEnvironment } from "./scenarios/scenario-environment.js";
import { createMatrixQaClient, provisionMatrixQaRoom } from "./substrate/client.js";
import { buildMatrixQaConfig } from "./substrate/config.js";
import type { MatrixQaObservedEvent } from "./substrate/events.js";
import { startMatrixQaHarness } from "./substrate/harness.runtime.js";
import { createMatrixQaRoomObserver } from "./substrate/sync.js";
import {
  mergeMatrixQaTopologySpecs,
  resolveMatrixQaRoomObserverRole,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologySpec,
} from "./substrate/topology.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const MATRIX_SHARED_FLOW_TOPOLOGY = {
  defaultRoomKey: "main",
  rooms: [
    {
      key: "main",
      kind: "group",
      members: ["driver", "observer", "sut"],
      name: "OpenClaw Matrix QA",
      requireMention: true,
    },
    {
      key: "secondary",
      kind: "group",
      members: ["driver", "observer", "sut"],
      name: "Matrix QA Secondary Room",
      requireMention: true,
    },
    {
      key: "driver-dm",
      kind: "dm",
      members: ["driver", "sut"],
      name: "Matrix QA Driver/SUT DM",
    },
    {
      key: "driver-dm-shared",
      kind: "dm",
      members: ["driver", "sut"],
      name: "Matrix QA Driver/SUT Shared DM",
    },
  ],
} satisfies MatrixQaTopologySpec;

function readMatrixQaScenarioTopology(scenarioId: string): MatrixQaTopologySpec | undefined {
  const value = readQaScenarioExecutionConfig(scenarioId)?.matrixTopology;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as MatrixQaTopologySpec;
}

function resolveMatrixQaAdapterTopology(scenarioIds: readonly string[] | undefined) {
  const scenarioTopologies = (scenarioIds ?? []).flatMap((scenarioId) => {
    const topology = readMatrixQaScenarioTopology(scenarioId);
    return topology ? [topology] : [];
  });
  return mergeMatrixQaTopologySpecs([MATRIX_SHARED_FLOW_TOPOLOGY, ...scenarioTopologies]);
}

function resolveMatrixQaAdapterRoom(
  topology: MatrixQaProvisionedTopology,
  conversation: { id: string; kind: "channel" | "direct" | "group" },
) {
  return (
    topology.rooms.find(
      (room) => room.key === conversation.id || room.roomId === conversation.id,
    ) ??
    (conversation.kind === "direct"
      ? topology.rooms.find((room) => room.kind === "dm")
      : undefined) ??
    topology.rooms.find((room) => room.roomId === topology.defaultRoomId)!
  );
}

async function waitForMatrixChannelReady(
  gateway: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"],
  accountId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadline) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: Math.min(2_000, timeoutMs) },
        { timeoutMs: Math.min(5_000, timeoutMs) },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      lastAccounts = accounts;
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (
        account?.running === true &&
        account.connected === true &&
        account.restartPending !== true &&
        account.healthState !== "degraded"
      ) {
        return;
      }
    } catch {
      // Retry until the shared host readiness deadline.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
  throw new Error(
    `matrix account "${accountId}" did not become ready; last accounts: ${JSON.stringify(lastAccounts ?? [])}`,
  );
}

export async function createMatrixQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const repoRoot = options.repoRoot?.trim() || process.cwd();
  const suffix = randomUUID().slice(0, 8);
  // Compose derives its default project name from this basename. Keep it unique so
  // programmatic parallel suite workers cannot stop or replace another harness.
  const harness = await startMatrixQaHarness({
    outputDir: path.join(context.outputDir, `matrix-harness-${suffix}`),
    repoRoot,
  });
  let provisioning: Awaited<ReturnType<typeof provisionMatrixQaRoom>>;
  try {
    provisioning = await provisionMatrixQaRoom({
      baseUrl: harness.baseUrl,
      driverLocalpart: `qa-driver-${suffix}`,
      observerLocalpart: `qa-observer-${suffix}`,
      registrationToken: harness.registrationToken,
      roomName: `OpenClaw Matrix QA ${suffix}`,
      sutLocalpart: `qa-sut-${suffix}`,
      topology: resolveMatrixQaAdapterTopology(options.scenarioIds),
    });
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  const observedEvents: MatrixQaObservedEvent[] = [];
  const roomObservers = provisioning.topology.rooms.map((room) => {
    const observerRole = resolveMatrixQaRoomObserverRole(room);
    return {
      observedEvents,
      observer: createMatrixQaRoomObserver({
        accessToken: provisioning[observerRole].accessToken,
        baseUrl: harness.baseUrl,
        observedEvents,
      }),
      roomId: room.roomId,
    };
  });
  try {
    await Promise.all(roomObservers.map(({ observer }) => observer.prime()));
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const driverClient = createMatrixQaClient({
    accessToken: provisioning.driver.accessToken,
    baseUrl: harness.baseUrl,
  });
  const observerClient = createMatrixQaClient({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
  });
  let stopped = false;
  let gatewayClient: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"] | undefined;
  let pollingError: Error | undefined;
  const logicalConversationByRoomId = new Map<
    string,
    { id: string; kind: "channel" | "direct" | "group" }
  >(
    provisioning.topology.rooms.map((room) => [
      room.roomId,
      { id: room.key, kind: room.kind === "dm" ? ("direct" as const) : ("channel" as const) },
    ]),
  );
  const nativeEventIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const scenarioEnvironment = createMatrixQaScenarioEnvironment({
    accountId,
    harness,
    observedEvents,
    provisioning,
  });
  const polling = Promise.all(
    roomObservers.map(async ({ observer, roomId }) => {
      for (;;) {
        if (stopped) {
          return;
        }
        const observed = await observer.waitForOptionalRoomEvent({
          predicate: (event) => event.sender === provisioning.sut.userId && Boolean(event.body),
          roomId,
          timeoutMs: 1_000,
        });
        if (!observed.matched) {
          continue;
        }
        const event = observed.event;
        const text = event.body;
        if (!text) {
          continue;
        }
        const logicalConversation = logicalConversationByRoomId.get(event.roomId);
        if (!logicalConversation) {
          continue;
        }
        const replacedMessageId =
          event.relatesTo?.relType === "m.replace" && event.relatesTo.eventId
            ? busMessageIds.get(event.relatesTo.eventId)
            : undefined;
        if (replacedMessageId) {
          const outbound = await context.messages.editMessage({
            accountId,
            messageId: replacedMessageId,
            text,
            timestamp: event.originServerTs,
          });
          // Replacements update the logical message but relations still target
          // the original Matrix event; only the reverse replacement map changes.
          busMessageIds.set(event.eventId, outbound.id);
          continue;
        }
        const outbound = await context.messages.addOutboundMessage({
          accountId,
          to: buildQaTarget({
            chatType: logicalConversation.kind,
            conversationId: logicalConversation.id,
          }),
          senderId: event.sender,
          text,
          timestamp: event.originServerTs,
          threadId:
            event.relatesTo?.relType === "m.thread" && event.relatesTo.eventId
              ? busMessageIds.get(event.relatesTo.eventId)
              : undefined,
          replyToId: event.relatesTo?.inReplyToId
            ? busMessageIds.get(event.relatesTo.inReplyToId)
            : undefined,
        });
        nativeEventIds.set(outbound.id, event.eventId);
        busMessageIds.set(event.eventId, outbound.id);
      }
    }),
  ).catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "matrix",
    label: "Matrix live",
    accountId,
    requiredPluginIds: ["matrix"],
    supportedActions: ["delete", "edit", "react"],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
    },
    async sendInbound(input) {
      const room = resolveMatrixQaAdapterRoom(provisioning.topology, input.conversation);
      logicalConversationByRoomId.set(room.roomId, {
        id: input.conversation.id,
        kind: input.conversation.kind,
      });
      const actor = input.senderId === "observer" ? provisioning.observer : provisioning.driver;
      const actorClient = input.senderId === "observer" ? observerClient : driverClient;
      const hasPortableMention = input.text.includes("@openclaw");
      const body = input.text.replaceAll("@openclaw", provisioning.sut.userId);
      const mentionUserIds = hasPortableMention ? [provisioning.sut.userId] : undefined;
      const replyToEventId = input.replyToId ? nativeEventIds.get(input.replyToId) : undefined;
      const threadRootEventId = input.threadId ? nativeEventIds.get(input.threadId) : undefined;
      let eventId: string;
      if (input.attachments?.length) {
        const sentEventIds: string[] = [];
        for (const [index, attachment] of input.attachments.entries()) {
          if (!attachment.contentBase64) {
            throw new Error(
              `Matrix live QA attachment ${attachment.id} requires inline contentBase64`,
            );
          }
          sentEventIds.push(
            await actorClient.sendMediaMessage({
              body: index === 0 ? body : undefined,
              buffer: Buffer.from(attachment.contentBase64, "base64"),
              contentType: attachment.mimeType,
              fileName: attachment.fileName,
              kind: attachment.kind,
              mentionUserIds: index === 0 ? mentionUserIds : undefined,
              replyToEventId,
              roomId: room.roomId,
              threadRootEventId,
            }),
          );
        }
        eventId = sentEventIds[0]!;
      } else {
        eventId = await actorClient.sendTextMessage({
          body,
          mentionUserIds,
          replyToEventId,
          roomId: room.roomId,
          threadRootEventId,
        });
      }
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: actor.userId,
      });
      nativeEventIds.set(message.id, eventId);
      busMessageIds.set(eventId, message.id);
      return message;
    },
    resetTransport: () => {
      nativeEventIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverAccessToken: provisioning.driver.accessToken,
        driverUserId: provisioning.driver.userId,
        homeserver: harness.baseUrl,
        observerAccessToken: provisioning.observer.accessToken,
        observerUserId: provisioning.observer.userId,
        sutAccessToken: provisioning.sut.accessToken,
        sutAccountId: accountId,
        sutDeviceId: provisioning.sut.deviceId,
        sutUserId: provisioning.sut.userId,
        topology: provisioning.topology,
      }),
    createRuntimeEnvPatch: () => ({
      OPENCLAW_QA_MATRIX_DRIVER_USER_ID: provisioning.driver.userId,
      OPENCLAW_QA_MATRIX_OBSERVER_USER_ID: provisioning.observer.userId,
      OPENCLAW_QA_MATRIX_SUT_ACCOUNT_ID: accountId,
      OPENCLAW_QA_MATRIX_MAIN_ROOM_ID:
        provisioning.topology.rooms.find((room) => room.key === "main")?.roomId ??
        provisioning.roomId,
      OPENCLAW_QA_MATRIX_SECONDARY_ROOM_ID:
        provisioning.topology.rooms.find((room) => room.key === "secondary")?.roomId ?? "",
    }),
    prepareFlow: scenarioEnvironment.prepareFlow,
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) => {
      gatewayClient = gateway;
      await waitForMatrixChannelReady(gateway, accountId, timeoutMs, pollIntervalMs);
    },
    buildAgentDelivery: () => ({
      channel: "matrix",
      to: provisioning.roomId,
      replyChannel: "matrix",
      replyTo: provisioning.roomId,
    }),
    async handleAction({ action, args }) {
      if (!gatewayClient) {
        throw new Error("Matrix live QA adapter is not connected to its Gateway");
      }
      const normalizedArgs = { ...args };
      for (const key of ["roomId", "channelId", "to"] as const) {
        const value = normalizedArgs[key];
        if (typeof value !== "string") {
          continue;
        }
        const room = provisioning.topology.rooms.find(
          (candidate) => candidate.key === value || candidate.roomId === value,
        );
        if (room) {
          normalizedArgs[key] = room.roomId;
        }
      }
      const messageId = normalizedArgs.messageId;
      if (typeof messageId === "string") {
        normalizedArgs.messageId = nativeEventIds.get(messageId) ?? messageId;
      }
      return await gatewayClient.call(
        "message.action",
        {
          channel: "matrix",
          action,
          accountId,
          params: normalizedArgs,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 60_000 },
      );
    },
    createReportNotes: () => ["Uses the Matrix live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await harness.stop();
    },
  };
}
