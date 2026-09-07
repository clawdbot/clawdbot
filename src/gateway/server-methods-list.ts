// Gateway method/event catalog.
// Lists advertised core, auxiliary, channel plugin methods, and websocket events.
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import {
  GATEWAY_EVENT_DEVICE_PAIR_CHANGED,
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
} from "./events.js";
import { listCoreAdvertisedGatewayMethodNames } from "./methods/core-descriptors.js";

type GatewayMethodChannelPlugin = {
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
};

function listChannelGatewayMethods(): string[] {
  const methods: string[] = [];
  for (const plugin of listLoadedChannelPlugins() as GatewayMethodChannelPlugin[]) {
    // Plugins may still expose legacy names while newer plugins expose descriptors.
    // Merge both so method discovery stays compatible during descriptor adoption.
    methods.push(...(plugin.gatewayMethods ?? []));
    for (const descriptor of plugin.gatewayMethodDescriptors ?? []) {
      methods.push(descriptor.name);
    }
  }
  return methods;
}

/** Returns the de-duplicated gateway method catalog advertised through method-list APIs. */
export function listGatewayMethods(): string[] {
  return Array.from(
    new Set([...listCoreAdvertisedGatewayMethodNames(), ...listChannelGatewayMethods()]),
  );
}

/** Gateway event names that clients can subscribe to or receive over the wire. */
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "chat.metadata.changed",
  "ui.command",
  "session.approval",
  "session.message",
  "session.observer",
  "session.operation",
  "session.sharing",
  "session.sharing.evidence",
  "session.suggestion",
  "session.typing",
  "session.tool",
  "sessions.changed",
  "controlUi.sessionPullRequests.changed",
  "plugins.controlUi.changed",
  "presence",
  "tick",
  "talk.mode",
  "talk.event",
  "shutdown",
  "gateway.suspension",
  "health",
  "heartbeat",
  "cron",
  "task",
  "task.suggestion",
  "node.pair.requested",
  "node.pair.resolved",
  "node.presence",
  "node.hostStats",
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  "node.invoke.cancel",
  "node.invoke.input",
  "node.invoke.request",
  GATEWAY_EVENT_DEVICE_PAIR_CHANGED,
  "device.pair.requested",
  "device.pair.resolved",
  "device.pair.setup.completed",
  "device.pair.setup.deliveryUncertain",
  "users.prefs.changed",
  "skills.changed",
  "voicewake.changed",
  "voicewake.routing.changed",
  "exec.approval.requested",
  "exec.approval.resolved",
  "question.requested",
  "question.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  "openclaw.approval.requested",
  "openclaw.approval.resolved",
  "terminal.data",
  "terminal.exit",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
  "portal.changed",
  "progressCard.changed",
  "mentions.changed",
];
