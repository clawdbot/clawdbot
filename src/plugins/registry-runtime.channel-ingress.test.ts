import { describe, expect, it, vi } from "vitest";
import type { BuildChannelInboundEventContextParams } from "../channels/inbound-event/context.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../channels/message-access/runtime-types.js";
import { resolveStableChannelMessageIngress } from "../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRuntimeBuilder(params: { origin: PluginOrigin; id?: string }) {
  const registryBuilder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      channel: { inbound: { buildContext: buildChannelInboundEventContext } },
    } as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: params.id ?? "channel-owner",
    origin: params.origin,
  });
  const api = registryBuilder.createApi(record, {
    config: {} as OpenClawConfig,
    registrationMode: "full",
  });
  api.registerChannel({
    plugin: {
      id: record.id,
      meta: {
        id: record.id,
        label: record.id,
        selectionLabel: record.id,
        docsPath: `/channels/${record.id}`,
        blurb: "test channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    },
  });
  registryBuilder.registry.plugins.push(record);
  markPluginRegistryActive(registryBuilder.registry);
  const resolveBuildContext = () => {
    const registration = registryBuilder.registry.channels.find(
      (candidate) => candidate.plugin.id === record.id,
    );
    const runtime = registration?.resolveChannelRuntime?.();
    if (!runtime) {
      throw new Error(`missing registered channel runtime for ${record.id}`);
    }
    return runtime.inbound.buildContext;
  };
  return { buildContext: resolveBuildContext(), record, registryBuilder, resolveBuildContext };
}

async function resolveIngress(
  participantId: string,
  params: {
    channelId?: string;
    conversation?: {
      kind: "direct" | "group" | "channel";
      id: string;
      parentId?: string;
      threadId?: string;
    };
    contextBinding?: {
      agentId: string;
      sessionKey: string;
      messageId: string;
      nativeChannelId?: string;
      inboundEventKind: "user_request" | "room_event";
    };
  } = {},
) {
  return await resolveStableChannelMessageIngress({
    channelId: params.channelId ?? "channel-owner",
    accountId: "default",
    subject: { stableId: participantId },
    conversation: params.conversation ?? { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    allowFrom: [participantId],
    contextBinding: params.contextBinding ?? {
      agentId: "main",
      sessionKey: "agent:main:channel-owner:dm:dm-1",
      messageId: "message-1",
      inboundEventKind: "user_request",
    },
  });
}

function contextParams(params: {
  ingress: ResolvedChannelMessageIngress | readonly ResolvedChannelMessageIngress[];
  channelId?: string;
  conversation?: BuildChannelInboundEventContextParams["conversation"];
  route?: BuildChannelInboundEventContextParams["route"];
  reply?: BuildChannelInboundEventContextParams["reply"];
  senderId?: string;
  messageId?: string;
  inboundEventKind?: BuildChannelInboundEventContextParams["message"]["inboundEventKind"];
}): BuildChannelInboundEventContextParams {
  return {
    channel: params.channelId ?? "channel-owner",
    accountId: "default",
    from: "test:dm-1",
    sender: { id: params.senderId ?? "person-a" },
    conversation: params.conversation ?? { kind: "direct", id: "dm-1" },
    route: params.route ?? {
      agentId: "main",
      routeSessionKey: "agent:main:channel-owner:dm:dm-1",
    },
    reply: params.reply ?? { to: "channel-owner:dm-1" },
    messageId: params.messageId ?? "message-1",
    message: {
      rawBody: "hello",
      inboundEventKind: params.inboundEventKind ?? "user_request",
    },
    channelIngress: params.ingress,
  };
}

function inspect(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
}

describe("bundled channel ingress runtime ownership", () => {
  it("binds authenticated owner turns to the exact live trusted channel plugin", async () => {
    const runtime = createPluginRuntime();
    const command = vi.fn(async () => ({ payloads: [] }));
    Object.defineProperty(runtime.agent, "runCommandFromIngress", {
      configurable: true,
      value: command,
    });
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const owner = createPluginRecord({ id: "discord", origin: "bundled" });
    const foreign = createPluginRecord({ id: "foreign", origin: "bundled" });
    const untrusted = createPluginRecord({ id: "impostor", origin: "workspace" });
    const ownerApi = registryBuilder.createApi(owner, { config: {} as OpenClawConfig });
    const foreignApi = registryBuilder.createApi(foreign, { config: {} as OpenClawConfig });
    const untrustedApi = registryBuilder.createApi(untrusted, { config: {} as OpenClawConfig });
    registryBuilder.registry.plugins.push(owner, foreign, untrusted);
    registryBuilder.registry.channels.push(
      {
        pluginId: "discord",
        plugin: { id: "discord" },
        source: owner.source,
      } as never,
      {
        pluginId: "impostor",
        plugin: { id: "community" },
        source: untrusted.source,
      } as never,
    );
    markPluginRegistryActive(registryBuilder.registry);
    const options = {
      message: "owner turn",
      messageChannel: "discord" as const,
      senderIsOwner: true,
      allowModelOverride: false,
    };
    const commandRuntime = { log: vi.fn(), error: vi.fn() } as never;
    const retained = ownerApi.runtime.agent.runCommandFromIngress;

    await expect(retained(options, commandRuntime)).resolves.toEqual({ payloads: [] });
    expect(command).toHaveBeenCalledWith(options, commandRuntime);
    await expect(
      foreignApi.runtime.agent.runCommandFromIngress(options, commandRuntime),
    ).rejects.toThrow('Plugin "foreign" cannot admit authenticated owner authority');
    const guestOptions = { ...options, messageChannel: "community", senderIsOwner: false };
    const retainedGuest = untrustedApi.runtime.agent.runCommandFromIngress;
    await expect(retainedGuest(guestOptions, commandRuntime)).resolves.toEqual({ payloads: [] });
    expect(command).toHaveBeenLastCalledWith(guestOptions, commandRuntime);
    let ownerClaimReads = 0;
    let channelReads = 0;
    const changingGuestOptions = {
      ...guestOptions,
      get senderIsOwner() {
        return ownerClaimReads++ > 0;
      },
      get messageChannel() {
        return channelReads++ === 0 ? "community" : "discord";
      },
    };
    await expect(retainedGuest(changingGuestOptions, commandRuntime)).resolves.toEqual({
      payloads: [],
    });
    expect(command).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageChannel: "community", senderIsOwner: false }),
      commandRuntime,
    );
    expect(ownerClaimReads).toBe(1);
    expect(channelReads).toBe(1);
    await expect(
      retainedGuest({ ...guestOptions, senderIsOwner: true }, commandRuntime),
    ).rejects.toThrow('Plugin "impostor" cannot admit authenticated owner authority');

    registryBuilder.rollbackPluginGlobalSideEffects(owner.id, owner);
    await expect(retained(options, commandRuntime)).rejects.toThrow(
      'Plugin "discord" cannot admit authenticated owner authority',
    );
    registryBuilder.rollbackPluginGlobalSideEffects(untrusted.id, untrusted);
    await expect(retainedGuest(guestOptions, commandRuntime)).rejects.toThrow(
      'Plugin "impostor" cannot admit authenticated owner authority',
    );
    expect(command).toHaveBeenCalledTimes(3);
  });

  it("defers and preserves the exact active runtime across an inactive prepared load", async () => {
    let channelReads = 0;
    const channel = { inbound: { buildContext: buildChannelInboundEventContext } };
    const runtime = Object.defineProperty({} as PluginRuntime, "channel", {
      configurable: true,
      get: () => {
        channelReads += 1;
        return channel;
      },
    });
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "deferred-channel", origin: "bundled" });
    const api = registryBuilder.createApi(record, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });

    api.registerChannel({
      plugin: {
        id: "deferred-channel",
        meta: {
          id: "deferred-channel",
          label: "Deferred Channel",
          selectionLabel: "Deferred Channel",
          docsPath: "/channels/deferred-channel",
          blurb: "test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });

    registryBuilder.registry.plugins.push(record);
    markPluginRegistryActive(registryBuilder.registry);
    const inactivePreparedRecord = createPluginRecord({
      id: record.id,
      origin: "bundled",
    });
    registryBuilder.createApi(inactivePreparedRecord, {
      config: {} as OpenClawConfig,
      registrationMode: "setup-only",
    });

    expect(channelReads).toBe(0);
    const registeredRuntime = registryBuilder.registry.channels[0]?.resolveChannelRuntime?.();
    expect(registeredRuntime).toBeDefined();
    expect(channelReads).toBe(1);

    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const ingress = await resolveIngress("person-a", { channelId: "deferred-channel" });
      expect(
        inspect(
          registeredRuntime!.inbound.buildContext(
            contextParams({ ingress, channelId: "deferred-channel" }),
          ),
        ),
      ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
    } finally {
      cleanup();
    }
  });

  it("mints only for the exact active bundled record", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const external = createRuntimeBuilder({ origin: "workspace" });
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");

      expect(inspect(external.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "enforced",
      });
    } finally {
      cleanup();
    }
  });

  it("consumes the exact resolution-to-context handoff on its first attempt", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");

      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "present",
        invoker: { state: "present" },
      });
      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("consumes a mismatched handoff so a corrected replay stays unknown", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");

      expect(
        inspect(
          bundled.buildContext(
            contextParams({
              ingress,
              conversation: { kind: "group", id: "other-room" },
            }),
          ),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    {
      name: "agent",
      context: {
        route: {
          agentId: "other-agent",
          routeSessionKey: "agent:main:channel-owner:dm:dm-1",
        },
      },
    },
    {
      name: "session",
      context: {
        route: {
          agentId: "main",
          routeSessionKey: "agent:main:channel-owner:dm:other",
        },
      },
    },
    { name: "message", context: { messageId: "message-2" } },
    { name: "event kind", context: { inboundEventKind: "room_event" as const } },
  ])("rejects first-use cross-$name substitution", async ({ context }) => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a", {
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:channel-owner:dm:dm-1",
          messageId: "message-1",
          inboundEventKind: "user_request",
        },
      });

      expect(
        inspect(
          bundled.buildContext(
            contextParams({
              ingress,
              route: context.route,
              messageId: context.messageId,
              inboundEventKind: context.inboundEventKind,
            }),
          ),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      cleanup();
    }
  });

  it("binds an admitted aggregate to its final source message", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const binding = {
        agentId: "main",
        sessionKey: "agent:main:channel-owner:dm:dm-1",
        inboundEventKind: "user_request" as const,
      };
      const first = await resolveIngress("person-a", {
        contextBinding: { ...binding, messageId: "message-1" },
      });
      const last = await resolveIngress("person-a", {
        contextBinding: { ...binding, messageId: "message-2" },
      });

      expect(
        inspect(
          bundled.buildContext(contextParams({ ingress: [first, last], messageId: "message-2" })),
        ),
      ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
    } finally {
      cleanup();
    }
  });

  it("requires an explicitly bound native conversation id at handoff", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a", {
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:channel-owner:dm:dm-1",
          messageId: "message-1",
          nativeChannelId: "native-dm-1",
          inboundEventKind: "user_request",
        },
      });

      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    {
      name: "conversation kind and id",
      ingressConversation: { kind: "direct" as const, id: "dm-1" },
      context: { conversation: { kind: "group" as const, id: "room-2" } },
    },
    {
      name: "thread",
      ingressConversation: {
        kind: "group" as const,
        id: "room-1",
        parentId: "parent-1",
        threadId: "thread-1",
      },
      context: {
        conversation: {
          kind: "group" as const,
          id: "room-1",
          parentId: "parent-1",
          threadId: "thread-2",
        },
      },
    },
    {
      name: "parent",
      ingressConversation: {
        kind: "group" as const,
        id: "room-1",
        parentId: "parent-1",
      },
      context: {
        conversation: { kind: "group" as const, id: "room-1", parentId: "parent-2" },
      },
    },
    {
      name: "native channel",
      ingressConversation: { kind: "direct" as const, id: "dm-1" },
      context: {
        conversation: { kind: "direct" as const, id: "dm-1", nativeChannelId: "other" },
      },
    },
    {
      name: "routing account owner",
      ingressConversation: { kind: "direct" as const, id: "dm-1" },
      context: {
        route: {
          agentId: "main",
          accountId: "other-account",
          routeSessionKey: "agent:main:channel-owner:dm:dm-1",
        },
      },
    },
    {
      name: "participant",
      ingressConversation: { kind: "direct" as const, id: "dm-1" },
      context: { senderId: "person-b" },
    },
    {
      name: "participant whitespace",
      ingressConversation: { kind: "direct" as const, id: "dm-1" },
      context: { senderId: " person-a " },
    },
  ])("rejects cross-scope $name substitution", async ({ ingressConversation, context }) => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a", { conversation: ingressConversation });
      expect(
        inspect(
          bundled.buildContext(
            contextParams({
              ingress,
              conversation: context.conversation,
              route: context.route,
              senderId: context.senderId,
            }),
          ),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      cleanup();
    }
  });

  it("rejects a stable event mutation on the exact resolver object", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");
      ingress.state.event.kind = "reaction";

      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("rejects accessor-bearing scope without invoking the accessor", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");
      const getter = vi.fn(() => {
        throw new Error("must not run");
      });
      Object.defineProperty(ingress.state, "event", { configurable: true, get: getter });

      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
      expect(getter).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("consumes the handoff before a context builder failure", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");
      expect(() =>
        bundled.buildContext({
          ...contextParams({ ingress }),
          finalize: () => {
            throw new Error("context failed");
          },
        }),
      ).toThrow("context failed");
      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("rejects a result after a same-id registered owner replaces its record", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const first = createRuntimeBuilder({ origin: "bundled", id: "shared-owner" });
      const firstIngress = await resolveIngress("person-a", { channelId: "shared-owner" });
      const second = createRuntimeBuilder({ origin: "bundled", id: "shared-owner" });

      expect(
        inspect(
          first.buildContext(contextParams({ ingress: firstIngress, channelId: "shared-owner" })),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
      expect(
        inspect(
          second.buildContext(contextParams({ ingress: firstIngress, channelId: "shared-owner" })),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      cleanup();
    }
  });

  it("keeps two active registered records exact and rejects cross-record reuse", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const alpha = createRuntimeBuilder({ origin: "bundled", id: "alpha-owner" });
      const beta = createRuntimeBuilder({ origin: "bundled", id: "beta-owner" });
      const alphaIngress = await resolveIngress("person-a", { channelId: "alpha-owner" });
      const betaIngress = await resolveIngress("person-b", { channelId: "beta-owner" });

      expect(
        inspect(
          alpha.buildContext(contextParams({ ingress: alphaIngress, channelId: "alpha-owner" })),
        ),
      ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
      expect(
        inspect(
          beta.buildContext(
            contextParams({ ingress: betaIngress, channelId: "beta-owner", senderId: "person-b" }),
          ),
        ),
      ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });

      const crossRecord = await resolveIngress("person-a", { channelId: "alpha-owner" });
      expect(
        inspect(
          beta.buildContext(contextParams({ ingress: crossRecord, channelId: "beta-owner" })),
        ),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      cleanup();
    }
  });

  it("invalidates the pre-retirement closure and result across reactivation", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");
      markPluginRegistryRetired(bundled.registryBuilder.registry);
      markPluginRegistryActive(bundled.registryBuilder.registry);

      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
      const reactivatedBuildContext = bundled.resolveBuildContext();
      const reactivatedIngress = await resolveIngress("person-a");
      expect(
        inspect(reactivatedBuildContext(contextParams({ ingress: reactivatedIngress }))),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present" },
      });
    } finally {
      cleanup();
    }
  });

  it("degrades stale, replaced, and rollback-owned closures to unknown", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const stale = createRuntimeBuilder({ origin: "bundled" });
      const replaced = createRuntimeBuilder({ origin: "bundled" });
      const rollback = createRuntimeBuilder({ origin: "bundled" });
      const ingress = await resolveIngress("person-a");

      expect(inspect(rollback.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "present",
      });

      markPluginRegistryRetired(stale.registryBuilder.registry);
      const replacementRecord = createPluginRecord({ id: replaced.record.id, origin: "bundled" });
      replaced.registryBuilder.createApi(replacementRecord, {
        config: {} as OpenClawConfig,
        registrationMode: "full",
      });
      rollback.registryBuilder.rollbackPluginGlobalSideEffects(rollback.record.id, rollback.record);

      for (const buildContext of [
        stale.buildContext,
        replaced.buildContext,
        rollback.buildContext,
      ]) {
        expect(inspect(buildContext(contextParams({ ingress })))).toMatchObject({
          ingressState: "unknown",
          invoker: { state: "unknown" },
        });
      }
    } finally {
      cleanup();
    }
  });

  it("rejects structural results and mixed collect participants", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const bundled = createRuntimeBuilder({ origin: "bundled" });
      const first = await resolveIngress("person-a");
      const same = await resolveIngress("person-a");
      const mixed = await resolveIngress("person-b");

      expect(inspect(bundled.buildContext(contextParams({ ingress: { ...first } })))).toMatchObject(
        {
          ingressState: "unknown",
        },
      );
      expect(
        inspect(bundled.buildContext(contextParams({ ingress: [first, same] }))),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present" },
      });
      expect(
        inspect(bundled.buildContext(contextParams({ ingress: [first, mixed] }))),
      ).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });
});
