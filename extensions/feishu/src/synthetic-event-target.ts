import type { FeishuMessageEvent } from "./event-types.js";

const directPreDispatchTargets = new WeakMap<FeishuMessageEvent, string>();

/** Keep synthetic-only routing metadata outside the public Feishu event shape. */
export function setFeishuSyntheticDirectPreDispatchTarget(
  event: FeishuMessageEvent,
  target: string,
): FeishuMessageEvent {
  directPreDispatchTargets.set(event, target);
  return event;
}

export function getFeishuSyntheticDirectPreDispatchTarget(
  event: FeishuMessageEvent,
): string | undefined {
  return directPreDispatchTargets.get(event);
}
