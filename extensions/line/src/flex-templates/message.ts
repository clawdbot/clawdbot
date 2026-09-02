import type { messagingApi } from "@line/bot-sdk";
import type { FlexBubble, FlexContainer } from "./types.js";

// LINE limits serialized UTF-8 JSON for each bubble and the whole carousel.
export const LINE_FLEX_BUBBLE_MAX_BYTES = 30_000;
export const LINE_FLEX_CAROUSEL_MAX_BYTES = 50_000;

export function fitsLineFlexBubble(bubble: FlexBubble): boolean {
  return Buffer.byteLength(JSON.stringify(bubble), "utf8") <= LINE_FLEX_BUBBLE_MAX_BYTES;
}
export function toFlexMessage(altText: string, contents: FlexContainer): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText,
    contents,
  };
}
