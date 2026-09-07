import { afterEach, describe, expect, it } from "vitest";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { registerChannelIngressHostOwner } from "../channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../channels/message-access/runtime.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { admitChannelAdministratorPolicy } from "./channel-administrator-policy.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

const grant = {
  channel: "discord" as const,
  accountId: "operations",
  senderId: "123456789012345678",
  conversationId: "234567890123456789",
};
const ownerAllowFrom = [`discord:${grant.senderId}`];
const cleanups: Array<() => void> = [];

installDiscordRegistryHooks();
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  clearRuntimeConfigSnapshot();
});

function makeConfig(commands: OpenClawConfig["commands"] = {}): OpenClawConfig {
  return { commands: { ownerAllowFrom, channelAdministrators: [grant], ...commands } };
}

async function buildNativeContext() {
  let live = true;
  const owner = {
    channelId: grant.channel,
    record: {},
    epoch: {},
    isLive: () => live,
  };
  cleanups.push(registerChannelIngressHostOwner(owner));
  const sessionKey = `agent:main:discord:channel:${grant.conversationId}`;
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: grant.channel,
    accountId: grant.accountId,
    subject: { stableId: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "345678901234567890",
      inboundEventKind: "user_request",
      nativeHumanSource: { senderId: grant.senderId, conversationId: grant.conversationId },
    },
    dmPolicy: "allowlist",
    groupPolicy: "open",
    allowFrom: [],
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const context = await buildContext({
    channel: grant.channel,
    accountId: grant.accountId,
    messageId: "345678901234567890",
    from: `discord:channel:${grant.conversationId}`,
    sender: { id: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: `channel:${grant.conversationId}` },
    message: { rawBody: "Update the automation." },
    channelIngress,
  });
  return {
    context,
    close: () => {
      live = false;
    },
  };
}

describe("channel administrator policy admission", () => {
  it("admits an authenticated native Discord owner with the exact configured grant", async () => {
    const config = makeConfig();
    setRuntimeConfigSnapshot(config);
    const { context } = await buildNativeContext();

    const assertActive = admitChannelAdministratorPolicy(context, config);

    expect(assertActive).toBeTypeOf("function");
    expect(assertActive).not.toThrow();
    // The same inbound message cannot start a second administrator run.
    expect(admitChannelAdministratorPolicy(context, config)).toBeUndefined();
  });

  it.each([
    { channelAdministrators: undefined },
    { channelAdministrators: [] },
    { ownerAllowFrom: undefined },
    { ownerAllowFrom: [] },
    { ownerAllowFrom: ["*"] },
    { ownerAllowFrom: ["discord:456789012345678901"] },
    { ownerAllowFrom: [`slack:${grant.senderId}`] },
  ])("denies missing administrator or explicit owner permission: %j", async (commands) => {
    const config = makeConfig(commands);
    setRuntimeConfigSnapshot(config);
    const { context } = await buildNativeContext();

    expect(admitChannelAdministratorPolicy(context, config)).toBeUndefined();
  });

  it.each([
    { accountId: "other-account" },
    { senderId: "456789012345678901" },
    { conversationId: "567890123456789012" },
  ])(
    "denies a different grant tuple without channel-wide or thread inheritance: %j",
    async (patch) => {
      const config = makeConfig({ channelAdministrators: [{ ...grant, ...patch }] });
      setRuntimeConfigSnapshot(config);
      const { context } = await buildNativeContext();

      expect(admitChannelAdministratorPolicy(context, config)).toBeUndefined();
    },
  );

  it("does not trust administrator claims or copied routing and owner fields", async () => {
    const config = makeConfig();
    setRuntimeConfigSnapshot(config);
    const { context } = await buildNativeContext();

    expect(admitChannelAdministratorPolicy({ ...context }, config)).toBeUndefined();
    expect(
      admitChannelAdministratorPolicy(
        {
          ...context,
          senderIsOwner: true,
          controlUiAdmin: true,
          channelAdministrator: grant,
        },
        config,
      ),
    ).toBeUndefined();
  });

  it.each([{ channelAdministrators: [] }, { ownerAllowFrom: [] }])(
    "revokes an admitted run when current configuration removes permission: %j",
    async (commands) => {
      const config = makeConfig();
      setRuntimeConfigSnapshot(config);
      const { context } = await buildNativeContext();
      const assertActive = admitChannelAdministratorPolicy(context, config);
      expect(assertActive).toBeTypeOf("function");

      setRuntimeConfigSnapshot(makeConfig(commands));

      expect(assertActive).toThrow("grant or command ownership was revoked");
    },
  );

  it("rejects a stale turn configuration if permission is revoked before admission", async () => {
    const staleConfig = makeConfig();
    setRuntimeConfigSnapshot(makeConfig({ channelAdministrators: [] }));
    const { context } = await buildNativeContext();

    expect(() => admitChannelAdministratorPolicy(context, staleConfig)).toThrow("revoked");
  });

  it("revokes an admitted run when the authenticated channel lifecycle closes", async () => {
    const config = makeConfig();
    setRuntimeConfigSnapshot(config);
    const { context, close } = await buildNativeContext();
    const assertActive = admitChannelAdministratorPolicy(context, config);
    expect(assertActive).toBeTypeOf("function");

    close();

    expect(assertActive).toThrow("no longer active");
  });
});
