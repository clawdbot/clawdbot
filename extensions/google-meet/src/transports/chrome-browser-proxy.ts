// Google Meet URL/account rules stay adapter-owned; browser/node mechanics live in core.
import {
  asMeetingBrowserTabs,
  callMeetingBrowserProxyOnNode,
  readMeetingBrowserTab,
  resolveMeetingBrowserNode,
  resolveMeetingBrowserNodeInfo,
  type MeetingBrowserCandidateTab,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { GOOGLE_MEET_BROWSER_NODE_ADAPTER } from "./google-meet-platform-constants.js";

export type BrowserTab = MeetingBrowserCandidateTab;

export async function resolveChromeNodeInfo(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}) {
  return await resolveMeetingBrowserNodeInfo({
    ...params,
    adapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  });
}

export async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  return await resolveMeetingBrowserNode({
    ...params,
    adapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  });
}

export async function callBrowserProxyOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) {
  return await callMeetingBrowserProxyOnNode({
    ...params,
    adapter: GOOGLE_MEET_BROWSER_NODE_ADAPTER,
  });
}

export const asBrowserTabs = asMeetingBrowserTabs;
export const readBrowserTab = readMeetingBrowserTab;
