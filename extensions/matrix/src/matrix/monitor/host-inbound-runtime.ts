import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "./runtime-api.js";

export type MatrixHostInboundRuntime = Pick<
  PluginRuntime["channel"]["inbound"],
  "buildContext" | "run"
>;

/** Prefer the gateway's owner-scoped inbound runtime; retain the existing non-gateway fallback. */
export function resolveMatrixHostInboundRuntime(params: {
  channelRuntime?: ChannelRuntimeSurface;
  fallback: MatrixHostInboundRuntime;
}): MatrixHostInboundRuntime {
  const inbound = params.channelRuntime?.["inbound"];
  if (!inbound || typeof inbound !== "object") {
    return params.fallback;
  }
  const buildContext = Reflect.get(inbound, "buildContext");
  const run = Reflect.get(inbound, "run");
  return typeof buildContext === "function" && typeof run === "function"
    ? (inbound as MatrixHostInboundRuntime) // SAFETY: Both members required by this Pick were just proven callable.
    : params.fallback;
}
