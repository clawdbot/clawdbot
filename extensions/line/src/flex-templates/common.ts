import type { FlexBox, FlexBubble, FlexText } from "./types.js";

export function attachFooterText(bubble: FlexBubble, footer: string) {
  bubble.footer = {
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: footer,
        size: "xs",
        color: "#AAAAAA",
        wrap: true,
        align: "center",
      } as FlexText,
    ],
    paddingAll: "lg",
    backgroundColor: "#FAFAFA",
  } as FlexBox;
}
