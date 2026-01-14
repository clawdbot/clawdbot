import type { AnyBridgeFrame } from "./types.js";

export function encodeLine(frame: AnyBridgeFrame) {
  return `${JSON.stringify(frame)}\n`;
}
