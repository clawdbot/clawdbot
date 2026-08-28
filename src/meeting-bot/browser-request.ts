import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import { resolveBrowserNodeDelegationRuntime } from "../plugins/runtime/browser-node-delegation.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
} from "./platform-adapter-contract.js";
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

type MeetingBrowserRouting = "legacy" | "browser-steward";

export async function resolveLocalMeetingBrowserRequest(
  runtime: PluginRuntime,
  routing: MeetingBrowserRouting = "legacy",
): Promise<MeetingBrowserRequestCaller> {
  if (routing === "browser-steward") {
    if (!(await runtime.gateway.isAvailable())) {
      throw new Error("Browser-owned browser capability unavailable");
    }
    const browser = resolveBrowserNodeDelegationRuntime(runtime);
    if (!browser) {
      throw new Error("Browser-owned browser capability unavailable");
    }
    return async (params) =>
      await browser.request({
        method: params.method,
        path: params.path,
        ...(params.body !== undefined ? { body: params.body } : {}),
        timeoutMs: params.timeoutMs,
        nodeId: "",
      });
  }
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
        legacyMeetingRuntime: true,
      },
      {
        timeoutMs: resolveBrowserGatewayTimeoutMs(params.timeoutMs),
        scopes: ["operator.admin"],
      },
    );
}
