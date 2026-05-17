import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";
import { listCoreAdvertisedGatewayMethodNames } from "./methods/core-descriptors.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

type GatewayMethodChannelPlugin = {
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
};

export function listCoreGatewayMethods(): string[] {
  return listCoreAdvertisedGatewayMethodNames();
}

function listChannelGatewayMethods(): string[] {
  const methods: string[] = [];
  for (const plugin of listLoadedChannelPlugins() as GatewayMethodChannelPlugin[]) {
    methods.push(...(plugin.gatewayMethods ?? []));
    for (const descriptor of plugin.gatewayMethodDescriptors ?? []) {
      methods.push(descriptor.name);
    }
  }
  return methods;
}

export function listGatewayMethods(): string[] {
  return Array.from(
    new Set([...listCoreGatewayMethods(), ...GATEWAY_AUX_METHODS, ...listChannelGatewayMethods()]),
  );
}

export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "session.message",
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
  "node.pair.requested",
  "node.pair.resolved",
  "node.invoke.request",
  "device.pair.requested",
  "device.pair.resolved",
  "voicewake.changed",
  "voicewake.routing.changed",
  "exec.approval.requested",
  "exec.approval.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
];
