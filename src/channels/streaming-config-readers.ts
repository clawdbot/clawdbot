// Pure readers for a channel entry's `streaming` config object.
//
// Split out of `streaming.ts` because that module also formats tool aggregates
// and therefore value-loads the tool-display/logging graph. Doctor contract
// closures read streaming config during config-compat migration, and doctor
// enumeration cold-loads those closures for every declaring plugin.
import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelStreamingConfig } from "../config/types.base.js";
import { asBoolean } from "../utils/boolean.js";

export type StreamingCompatEntry = { streaming?: unknown };

export function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
}

export function resolveChannelStreamingNativeTransport(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  return asBoolean(getChannelStreamingConfigObject(entry)?.nativeTransport);
}
