// Line plugin module implements message behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { FlexBubble, FlexContainer } from "./types.js";

// LINE rejects the whole push or reply when any bubble's JSON exceeds this, so a
// card that cannot fit has to be given up before it reaches the wire, not sent
// and lost together with everything batched alongside it.
const LINE_FLEX_BUBBLE_MAX_BYTES = 30_000;

/** Whether LINE will accept this bubble, measured the way LINE measures it. */
export function fitsLineFlexBubble(bubble: FlexBubble): boolean {
  return Buffer.byteLength(JSON.stringify(bubble), "utf8") <= LINE_FLEX_BUBBLE_MAX_BYTES;
}

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
