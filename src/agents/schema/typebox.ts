import { Type } from "@sinclair/typebox";
import {
  CHANNEL_TARGET_DESCRIPTION,
  CHANNEL_TARGETS_DESCRIPTION,
} from "../../infra/outbound/channel-target.js";
export { optionalStringEnum, stringEnum } from "./string-enum.js";

export function channelTargetSchema(options?: { description?: string }) {
  return Type.String({
    description: options?.description ?? CHANNEL_TARGET_DESCRIPTION,
  });
}

export function channelTargetsSchema(options?: { description?: string }) {
  return Type.Array(
    channelTargetSchema({ description: options?.description ?? CHANNEL_TARGETS_DESCRIPTION }),
  );
}
