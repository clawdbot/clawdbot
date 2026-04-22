import { expect, it } from "vitest";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";

export function installChannelSurfaceContractSuite(params: {
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surface:
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway";
}) {
  it(`exposes the ${params.surface} surface contract`, () => {
    expectChannelSurfaceContract(params);
  });
}

export function expectChannelSurfaceContract(params: {
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surface:
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway";
}) {
  const { plugin, surface } = params;

  if (surface === "actions") {
    expect(plugin.actions).toBeDefined();
    expect(typeof plugin.actions?.describeMessageTool).toBe("function");
    return;
  }

  if (surface === "setup") {
    expect(plugin.setup).toBeDefined();
    expect(typeof plugin.setup?.applyAccountConfig).toBe("function");
    return;
  }

  if (surface === "status") {
    expect(plugin.status).toBeDefined();
    expect(typeof plugin.status?.buildAccountSnapshot).toBe("function");
    return;
  }

  if (surface === "outbound") {
    const outbound = plugin.outbound;
    expect(outbound).toBeDefined();
    expect(["direct", "gateway", "hybrid"]).toContain(outbound?.deliveryMode);
    expect(
      [
        outbound?.sendPayload,
        outbound?.sendFormattedText,
        outbound?.sendFormattedMedia,
        outbound?.sendText,
        outbound?.sendMedia,
        outbound?.sendPoll,
      ].some((value) => typeof value === "function"),
    ).toBe(true);
    return;
  }

  if (surface === "messaging") {
    const messaging = plugin.messaging;
    expect(messaging).toBeDefined();
    expect(
      [
        messaging?.normalizeTarget,
        messaging?.parseExplicitTarget,
        messaging?.inferTargetChatType,
        messaging?.buildCrossContextPresentation,
        messaging?.enableInteractiveReplies,
        messaging?.hasStructuredReplyPayload,
        messaging?.formatTargetDisplay,
        messaging?.resolveOutboundSessionRoute,
      ].some((value) => typeof value === "function"),
    ).toBe(true);
    if (messaging?.targetResolver) {
      if (messaging.targetResolver.looksLikeId) {
        expect(typeof messaging.targetResolver.looksLikeId).toBe("function");
      }
      if (messaging.targetResolver.hint !== undefined) {
        expect(typeof messaging.targetResolver.hint).toBe("string");
        expect(messaging.targetResolver.hint.trim()).not.toBe("");
      }
      if (messaging.targetResolver.resolveTarget) {
        expect(typeof messaging.targetResolver.resolveTarget).toBe("function");
      }
    }
    return;
  }

  if (surface === "threading") {
    const threading = plugin.threading;
    expect(threading).toBeDefined();
    expect(
      [
        threading?.resolveReplyToMode,
        threading?.buildToolContext,
        threading?.resolveAutoThreadId,
        threading?.resolveReplyTransport,
        threading?.resolveFocusedBinding,
      ].some((value) => typeof value === "function"),
    ).toBe(true);
    return;
  }

  if (surface === "directory") {
    const directory = plugin.directory;
    expect(directory).toBeDefined();
    expect(
      [
        directory?.self,
        directory?.listPeers,
        directory?.listPeersLive,
        directory?.listGroups,
        directory?.listGroupsLive,
        directory?.listGroupMembers,
      ].some((value) => typeof value === "function"),
    ).toBe(true);
    return;
  }

  const gateway = plugin.gateway;
  expect(gateway).toBeDefined();
  expect(
    [
      gateway?.startAccount,
      gateway?.stopAccount,
      gateway?.loginWithQrStart,
      gateway?.loginWithQrWait,
      gateway?.logoutAccount,
    ].some((value) => typeof value === "function"),
  ).toBe(true);
}
