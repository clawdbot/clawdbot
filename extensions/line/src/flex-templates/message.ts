import type { messagingApi } from "@line/bot-sdk";
import type { FlexContainer } from "./types.js";

/**
 * Wrap a FlexContainer in a FlexMessage
 */
export function toFlexMessage(altText: string, contents: FlexContainer): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText,
    contents,
  };
}
