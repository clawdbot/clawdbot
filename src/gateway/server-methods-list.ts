// Gateway method/event catalog.
// Lists advertised core, auxiliary, channel plugin methods, and websocket events.
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";
import { listCoreAdvertisedGatewayMethodNames } from "./methods/core-descriptors.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

type GatewayMethodChannelPlugin = {
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
};

/** Lists core methods intentionally advertised to gateway clients. */
function listCoreGatewayMethods(): string[] {
  return listCoreAdvertisedGatewayMethodNames();
}

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
    new Set([...listCoreGatewayMethods(), ...GATEWAY_AUX_METHODS, ...listChannelGatewayMethods()]),
  );
}

/** Gateway event names that clients can subscribe to or receive over the wire. */
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "ui.command",
  "session.approval",
  "session.message",
  "session.observer",
  "session.operation",
  "session.tool",
  "sessions.changed",
  "presence",
  "tick",
  "talk.mode",
  "talk.event",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "task",
  "task.suggestion",
  "node.pair.requested",
  "node.pair.resolved",
  "node.presence",
  "node.invoke.cancel",
  "node.invoke.input",
  "node.invoke.request",
  "device.pair.requested",
  "device.pair.resolved",
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
];
