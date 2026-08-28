import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type BrowserRoute = { profile: string } & (
  | { target: "host"; node?: never }
  | { target: "node"; node: string }
);

export type BrowserTabTarget = BrowserRoute & { targetId: string };
export type BrowserTabSelection = { tab: BrowserTabTarget; revision: string };

function isIdentifier(value: unknown, maxChars = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim() === value
  );
}

/** A partial descriptor cannot identify a browser; never guess its route. */
export function readBrowserTabTarget(value: unknown): BrowserTabTarget | undefined {
  const tab = asNullableRecord(value);
  if (!isIdentifier(tab?.targetId) || !isIdentifier(tab.profile)) {
    return undefined;
  }
  const identity = { targetId: tab.targetId, profile: tab.profile };
  if (tab.target === "host" && tab.node === undefined) {
    return { ...identity, target: "host" };
  }
  if (tab.target === "node" && isIdentifier(tab.node, 256)) {
    return { ...identity, target: "node", node: tab.node };
  }
  return undefined;
}

export function browserRouteKey(route?: BrowserRoute): string {
  return JSON.stringify([route?.target, route?.node, route?.profile]);
}

export function browserTabKey(tab: BrowserTabTarget): string {
  return JSON.stringify([tab.target, tab.node, tab.profile, tab.targetId]);
}
