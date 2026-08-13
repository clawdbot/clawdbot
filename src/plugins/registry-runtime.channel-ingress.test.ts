import { describe, expect, it } from "vitest";
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
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRuntimeBuilder(params: { origin: PluginOrigin }) {
  const registryBuilder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      channel: { inbound: { buildContext: buildChannelInboundEventContext } },
    } as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "channel-owner",
    origin: params.origin,
  });
  const api = registryBuilder.createApi(record, {
    config: {} as OpenClawConfig,
    registrationMode: "full",
  });
  const buildContext = api.runtime.channel.inbound.buildContext;
  registryBuilder.registry.plugins.push(record);
  markPluginRegistryActive(registryBuilder.registry);
  return { buildContext, record, registryBuilder };
}

async function resolveIngress(participantId: string) {
  return await resolveStableChannelMessageIngress({
    channelId: "test",
    accountId: "default",
    subject: { stableId: participantId },
    conversation: { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    allowFrom: [participantId],
  });
}

function contextParams(params: {
  ingress: ResolvedChannelMessageIngress | readonly ResolvedChannelMessageIngress[];
  senderId?: string;
}): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    accountId: "default",
    from: "test:dm-1",
    sender: { id: params.senderId ?? "person-a" },
    conversation: { kind: "direct", id: "dm-1" },
    route: { agentId: "main", routeSessionKey: "agent:main:test:dm:dm-1" },
    reply: { to: "test:dm-1" },
    message: { rawBody: "hello" },
    channelIngress: params.ingress,
  };
}

function inspect(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
}

describe("bundled channel ingress runtime ownership", () => {
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
