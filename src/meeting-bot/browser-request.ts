import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
} from "./platform-adapter.js";
import type { MeetingBrowserCandidateTab } from "./session-types.js";

export function asMeetingBrowserTabs(result: unknown): MeetingBrowserCandidateTab[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return Array.isArray(record.tabs) ? (record.tabs as MeetingBrowserCandidateTab[]) : [];
}

export function readMeetingBrowserTab(result: unknown): MeetingBrowserCandidateTab | undefined {
  return result && typeof result === "object" ? (result as MeetingBrowserCandidateTab) : undefined;
}

function resolveBrowserGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

async function callLocalBrowserRequest(params: MeetingBrowserRequestParams) {
  return await callGatewayFromCli(
    "browser.request",
    {
      json: true,
      timeout: String(resolveBrowserGatewayTimeoutMs(params.timeoutMs)),
    },
    {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    { progress: false },
  );
}

export async function resolveLocalMeetingBrowserRequest(
  runtime: PluginRuntime,
): Promise<MeetingBrowserRequestCaller> {
  // Gateway-hosted plugin work stays in-process; otherwise agent tools would
  // need an external operator.admin token just to reach the local browser.
  if (!(await runtime.gateway.isAvailable())) {
    return callLocalBrowserRequest;
  }
  return async (params) =>
    await runtime.gateway.request(
      "browser.request",
      {
        method: params.method,
        path: params.path,
        body: params.body,
        timeoutMs: params.timeoutMs,
      },
      {
        timeoutMs: resolveBrowserGatewayTimeoutMs(params.timeoutMs),
        scopes: ["operator.admin"],
      },
    );
}
