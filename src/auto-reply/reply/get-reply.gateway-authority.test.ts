import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { registerChannelIngressHostOwner } from "../../channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../../channels/message-access/runtime.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { initFastReplySessionState, withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

let state: OpenClawTestState | undefined;
let disposeOwner: (() => void) | undefined;
afterEach(async () => {
  disposeOwner?.();
  await state?.cleanup();
  vi.clearAllMocks();
});

it.each(["live", "retired", "replaced", "unbound"])(
  "retains only the original %s Gateway owner through reply preparation",
  async (lifecycle) => {
    state = await createOpenClawTestState({
      label: "channel-gateway-authority",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const cfg = withFullRuntimeReplyConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: false },
      session: { dmScope: "per-channel-peer" },
    });
    await state.writeConfig(cfg);
    const gatewayContext = { owner: "gateway-a" } as never;
    let live = true;
    const owner = {
      channelId: "discord",
      record: {},
      epoch: {},
      isLive: () => live,
      resolveGatewayContext: () => (live ? gatewayContext : undefined),
    };
    disposeOwner = registerChannelIngressHostOwner(owner);
    const sessionKey = "agent:main:discord:direct:person-42";
    const ingress = await resolveStableChannelMessageIngress({
      channelId: "discord",
      accountId: "primary",
      subject: { stableId: "person-42" },
      conversation: { kind: "direct", id: "dm-1" },
      contextBinding: {
        agentId: "main",
        sessionKey,
        messageId: "msg-1",
        inboundEventKind: "user_request",
      },
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
      allowFrom: ["person-42"],
    });
    const context = await createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    )({
      channel: "discord",
      accountId: "primary",
      messageId: "msg-1",
      from: "discord:user:person-42",
      sender: { id: "person-42" },
      conversation: { kind: "direct", id: "dm-1", nativeChannelId: "dm-1" },
      route: { agentId: "main", routeSessionKey: sessionKey },
      reply: { to: "channel:dm-1" },
      message: { rawBody: "hello" },
      channelIngress: ingress,
    });
    expect(readChannelContextGatewayContextResolver(context)?.()).toBe(gatewayContext);
    const input = finalizeInboundContext(lifecycle === "unbound" ? { ...context } : context);
    const fast = initFastReplySessionState({
      ctx: input,
      cfg,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: state.workspaceDir,
    });
    const fastResolver = readChannelContextGatewayContextResolver(fast.sessionCtx);
    expect(fastResolver?.()).toBe(lifecycle === "unbound" ? undefined : gatewayContext);
    let observedGateway: unknown;
    let resolverPresent = false;
    vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
      const admitted = await params.preparedRunAdmission!.admit("plugin-harness");
      resolverPresent = getGatewayContextResolver(admitted) !== undefined;
      if (lifecycle === "retired") {
        live = false;
      } else if (lifecycle === "replaced") {
        live = false;
        disposeOwner?.();
        disposeOwner = registerChannelIngressHostOwner({
          ...owner,
          record: {},
          epoch: {},
          resolveGatewayContext: () => ({ owner: "gateway-b" }) as never,
        });
      }
      observedGateway = getGatewayContextResolver(admitted)?.();
      return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    });
    await getReplyFromConfig(input, {}, cfg);
    expect(runEmbeddedAgent).toHaveBeenCalled();
    expect(resolverPresent).toBe(lifecycle !== "unbound");
    expect(observedGateway).toBe(lifecycle === "live" ? gatewayContext : undefined);
    expect(fastResolver?.()).toBe(lifecycle === "live" ? gatewayContext : undefined);
  },
);
