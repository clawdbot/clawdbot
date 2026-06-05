// Doctor helper for resolving channel-specific direct-message allowlist semantics.
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { AllowFromMode } from "./allow-from-mode.types.js";

export type { AllowFromMode } from "./allow-from-mode.types.js";

/** Return the allowFrom interpretation mode advertised by a channel's doctor metadata. */
export function resolveAllowFromMode(channelName: string): AllowFromMode {
  return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
