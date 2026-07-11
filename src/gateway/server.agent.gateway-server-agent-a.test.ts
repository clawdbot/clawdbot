/**
 * Gateway server-agent integration tests for agent startup and session dispatch.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
} from "../test-utils/channel-plugins.js";
import { waitForAgentCommandCall } from "./agent-command.test-helpers.js";
import { resetModelCatalogCacheForTest as resetGatewayModelCatalogCacheForTest } from "./server-model-catalog.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommand,
  installGatewayTestHooks,
  agentDiscoveryMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-session-");

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

const TEXT_ONLY_AGENT_MODEL = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "ollama-cloud",
  input: ["text"],
};

const VISION_AGENT_MODEL = {
  id: "gemma4:31b",
  name: "Gemma 4 31B",
  provider: "ollama-cloud",
  input: ["text", "image"],
};

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
  const runContext = call.runContext as { messageChannel?: string } | undefined;
  expect(runContext?.messageChannel).toBe(channel);
}

async function setTestSessionStore(params: {
  entries: Record<string, Record<string, unknown>>;
  agentId?: string;
}) {
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({
    entries: params.entries,
    agentId: params.agentId,
  });
}

async function runMainAgentDeliveryWithSession(params: {
  entry: Record<string, unknown>;
  request: Record<string, unknown>;
  allowFrom?: string[];
}) {
  setRegistry(defaultRegistry);
  testState.allowFrom = params.allowFrom ?? ["+1555"];
  try {
    await setTestSessionStore({
      entries: {
        main: {
          ...params.entry,
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      ...params.request,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return await waitForAgentCommandCall(String(params.request.idempotencyKey));
  } finally {
    testState.allowFrom = undefined;
  }
}

async function setGatewayModelCatalogForTest(
  models: typeof agentDiscoveryMock.models,
): Promise<void> {
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = models;
  await resetGatewayModelCatalogCacheForTest();
}

const baseImageAttachment = () => ({
  mimeType: "image/png",
  fileName: "tiny.png",
  content: BASE_IMAGE_PNG,
});

async function runAgentImageRequest(params: {
  idempotencyKey: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  failureMessage: string;
}) {
  await setTestSessionStore({
    agentId: params.agentId,
    entries: {
      main: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    },
  });

  const res = await rpcReq(gatewaySuite.ws, "agent", {
    message: "what is in the image?",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey ?? "main",
    attachments: [baseImageAttachment()],
    idempotencyKey: params.idempotencyKey,
  });
  expect(res.ok, `${params.failureMessage}: ${JSON.stringify(res)}`).toBe(true);

  return await waitForAgentCommandCall(params.idempotencyKey);
}

function expectBaseImageForwarded(images: unknown) {
  const forwarded = images as Array<Record<string, unknown>> | undefined;
  expect(forwarded, "agent command should include one forwarded image attachment").toHaveLength(1);
  expect(forwarded?.[0]?.type).toBe("image");
  expect(forwarded?.[0]?.mimeType).toBe("image/png");
  expect(forwarded?.[0]?.data).toBe(BASE_IMAGE_PNG);
}

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveAllowFrom?: (cfg: Record<string, unknown>) => string[];
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: {
      resolveAllowFrom: params.resolveAllowFrom
        ? ({ cfg }) => params.resolveAllowFrom?.(cfg as Record<string, unknown>) ?? []
        : undefined,
    },
  }),
  outbound: createDirectOutboundTestAdapter({
    channel: params.id,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        return { ok: true, to: trimmed };
      }
      const first = allowFrom?.[0];
      if (first) {
        return { ok: true, to: first };
      }
      return {
        ok: false,
        error: new Error(`missing target for ${params.id}`),
      };
    },
  }),
});

const defaultDirectChannelEntries = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "signal", label: "Signal" },
] as const;

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "whatsapp",
      label: "WhatsApp",
      resolveAllowFrom: (cfg) => {
        const channels = cfg.channels as Record<string, unknown> | undefined;
        const entry = channels?.whatsapp as Record<string, unknown> | undefined;
        const allow = entry?.allowFrom;
        return Array.isArray(allow) ? allow.map((value) => String(value)) : [];
      },
    }),
  },
  ...defaultDirectChannelEntries.map((entry) => ({
    pluginId: entry.id,
    source: "test",
    plugin: createStubChannelPlugin({ id: entry.id, label: entry.label }),
  })),
]);

describe("gateway server agent", () => {
  beforeEach(() => {
    vi.mocked(agentCommand).mockClear();
    testState.agentsConfig = undefined;
    testState.allowFrom = undefined;
    setRegistry(defaultRegistry);
  });

  afterEach(() => {
    testState.agentsConfig = undefined;
    testState.allowFrom = undefined;
  });

  test("keeps accepted detached agent work on its retained request root", async () => {
    await setTestSessionStore({
      entries: {
        main: {
          sessionId: "sess-agent-detached-root",
          updatedAt: Date.now(),
        },
      },
    });
    let subordinateAdmissionClosed: boolean | undefined;
    vi.mocked(agentCommand).mockImplementationOnce(async () => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      try {
        subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
      } finally {
        suspension?.rollback();
      }
    });

    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "prove detached root transfer",
      sessionKey: "main",
      idempotencyKey: "idem-agent-detached-root",
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("accepted");
    await vi.waitFor(() => {
      expect(subordinateAdmissionClosed).toBe(false);
    });
    await vi.waitFor(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
  });

  test("agent marks implicit delivery when lastTo is stale", async () => {
    testState.allowFrom = ["+436769770569"];
    await setTestSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-stale",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
        },
      },
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-stale",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const call = await waitForAgentCommandCall("idem-agent-last-stale");
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliveryTargetMode).toBe("implicit");
    expect(call.sessionId).toBe("sess-main-stale");
    testState.allowFrom = undefined;
  });

  test("agent forwards sessionKey to agentCommand", async () => {
    await setTestSessionStore({
      entries: {
        "agent:main:subagent:abc": {
          sessionId: "sess-sub",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "agent:main:subagent:abc",
      idempotencyKey: "idem-agent-subkey",
    });
    expect(res.ok).toBe(true);

    const call = await waitForAgentCommandCall("idem-agent-subkey");
    expect(call.sessionKey).toBe("agent:main:subagent:abc");
    expect(call.sessionId).toBe("sess-sub");
    expectChannels(call, "webchat");
    expect(call.deliver).toBe(false);
    expect(call.to).toBeUndefined();
  });

  test("agent forwards sourceReplyDeliveryMode to agentCommand", async () => {
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "main",
      sourceReplyDeliveryMode: "message_tool_only",
      idempotencyKey: "idem-agent-source-reply-mode",
    });
    expect(res.ok).toBe(true);

    const call = await waitForAgentCommandCall("idem-agent-source-reply-mode");
    expect(call.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  test("agent preserves spawnDepth on subagent sessions", async () => {
    await setTestSessionStore({
      entries: {
        "agent:main:subagent:depth": {
          sessionId: "sess-sub-depth",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnDepth: 2,
        },
      },
    });

    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "agent:main:subagent:depth",
      idempotencyKey: "idem-agent-subdepth",
    });
    expect(res.ok).toBe(true);
    await waitForAgentCommandCall("idem-agent-subdepth");

    const persisted = loadSessionEntry({
      sessionKey: "agent:main:subagent:depth",
      storePath: gatewaySuite.sessionStorePath,
    }) as { spawnDepth?: number; spawnedBy?: string } | undefined;
    expect(persisted?.spawnDepth).toBe(2);
    expect(persisted?.spawnedBy).toBe("agent:main:main");
  });

  test("agent derives sessionKey from agentId", async () => {
    testState.agentsConfig = { list: [{ id: "ops" }] };
    await setTestSessionStore({
      agentId: "ops",
      entries: {
        main: {
          sessionId: "sess-ops",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      agentId: "ops",
      idempotencyKey: "idem-agent-id",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const call = await waitForAgentCommandCall("idem-agent-id");
    expect(call.sessionKey).toBe("agent:ops:main");
    expect(call.sessionId).toBe("sess-ops");
  });

  test("agent rejects unknown reply channel", async () => {
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      replyChannel: "unknown-channel",
      idempotencyKey: "idem-agent-reply-unknown",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("unknown channel");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent rejects mismatched agentId and sessionKey", async () => {
    testState.agentsConfig = { list: [{ id: "ops" }] };
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      agentId: "ops",
      sessionKey: "agent:main:main",
      idempotencyKey: "idem-agent-mismatch",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("does not match session key agent");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent rejects malformed agent-prefixed session keys", async () => {
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "agent:main",
      idempotencyKey: "idem-agent-malformed-key",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("malformed session key");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent forwards accountId to agentCommand", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-account",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "default",
      },
      request: {
        accountId: "kev",
        idempotencyKey: "idem-agent-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
    const runContext = call.runContext as { accountId?: string } | undefined;
    expect(runContext?.accountId).toBe("kev");
  });

  test("agent avoids lastAccountId when explicit to is provided", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-explicit",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "legacy",
      },
      request: {
        to: "+1666",
        idempotencyKey: "idem-agent-explicit",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBeUndefined();
  });

  test("agent keeps explicit accountId when explicit to is provided", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-explicit-account",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "legacy",
      },
      request: {
        to: "+1666",
        accountId: "primary",
        idempotencyKey: "idem-agent-explicit-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBe("primary");
  });

  test("agent falls back to lastAccountId for implicit delivery", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-implicit",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
      },
      request: {
        idempotencyKey: "idem-agent-implicit-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
  });

  test("agent forwards image attachments as images[]", async () => {
    testState.agentConfig = { model: { primary: "ollama-cloud/gemma4:31b" } };
    await setGatewayModelCatalogForTest([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);
    const call = await runAgentImageRequest({
      idempotencyKey: "idem-agent-attachments",
      sessionId: "sess-main-images",
      failureMessage: "agent RPC failed before forwarding image attachment",
    });

    expect(call.sessionKey).toBe("agent:main:main");
    expectChannels(call, "webchat");
    expect(typeof call.message).toBe("string");
    expect(call.message).toContain("what is in the image?");
    expectBaseImageForwarded(call.images);
  });

  test("agent validates first image attachment against per-agent model for fresh sessions", async () => {
    testState.agentConfig = { model: { primary: "ollama-cloud/deepseek-v4-flash" } };
    testState.agentsConfig = {
      list: [
        { id: "main", default: true },
        { id: "vision", model: "ollama-cloud/gemma4:31b" },
      ],
    };
    await setGatewayModelCatalogForTest([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);

    const call = await runAgentImageRequest({
      agentId: "vision",
      sessionKey: "agent:vision:main",
      idempotencyKey: "idem-agent-vision-first-image",
      sessionId: "sess-vision-fresh-image",
      failureMessage: "agent RPC should accept image using per-agent vision model",
    });

    expect(call.sessionKey).toBe("agent:vision:main");
    expectBaseImageForwarded(call.images);
  });

  test("agent errors when delivery requested and no last channel exists", async () => {
    testState.allowFrom = ["+1555"];
    try {
      await setTestSessionStore({
        entries: {
          main: {
            sessionId: "sess-main-missing-provider",
            updatedAt: Date.now(),
          },
        },
      });
      const res = await rpcReq(gatewaySuite.ws, "agent", {
        message: "hi",
        sessionKey: "main",
        deliver: true,
        bestEffortDeliver: false,
        idempotencyKey: "idem-agent-missing-provider",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_REQUEST");
      expect(res.error?.message).toContain("Channel is required");
      expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();
    } finally {
      testState.allowFrom = undefined;
    }
  });

  test.each([
    {
      name: "whatsapp",
      sessionId: "sess-main-whatsapp",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      idempotencyKey: "idem-agent-last-whatsapp",
    },
    {
      name: "telegram",
      sessionId: "sess-main",
      lastChannel: "telegram",
      lastTo: "123",
      idempotencyKey: "idem-agent-last",
    },
    {
      name: "discord",
      sessionId: "sess-discord",
      lastChannel: "discord",
      lastTo: "channel:discord-123",
      idempotencyKey: "idem-agent-last-discord",
    },
    {
      name: "slack",
      sessionId: "sess-slack",
      lastChannel: "slack",
      lastTo: "channel:slack-123",
      idempotencyKey: "idem-agent-last-slack",
    },
    {
      name: "signal",
      sessionId: "sess-signal",
      lastChannel: "signal",
      lastTo: "+15551234567",
      idempotencyKey: "idem-agent-last-signal",
    },
  ])("agent routes main last-channel $name", async (tc) => {
    await setTestSessionStore({
      entries: {
        main: {
          sessionId: tc.sessionId,
          updatedAt: Date.now(),
          lastChannel: tc.lastChannel,
          lastTo: tc.lastTo,
        },
      },
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: tc.idempotencyKey,
    });
    expect(res.ok).toBe(true);

    const call = await waitForAgentCommandCall(tc.idempotencyKey);
    expectChannels(call, tc.lastChannel);
    expect(call.to).toBe(tc.lastTo);
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe(tc.sessionId);
  });
});
