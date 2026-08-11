import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { describeBrowserExecTool } from "./browser-exec-tool-description.js";
import { BrowserExecToolOutputSchema, BrowserExecToolSchema } from "./browser-exec-tool.schema.js";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPES,
} from "./browser-gateway-contract.js";
import { parseBrowserTabToolBinding } from "./browser-tool-binding.js";
import {
  callGatewayTool,
  fetchBrowserJson,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  jsonResult,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringParam,
  resolveBrowserConfig,
  resolveProfile,
  type AnyAgentTool,
} from "./browser-tool.runtime.js";
import {
  resolveBrowserExecTimeoutMs,
  type BrowserExecResult,
} from "./browser/browser-exec-engine.js";

const BROWSER_EXEC_TRANSPORT_SLACK_MS = 5_000;

type BrowserExecToolOptions = {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  runToolBinding?: unknown;
};

function appendExecNextStep(message: string): string {
  const nextStep =
    "Retry browser_exec after checking the script. If a ref may be stale, call snapshot() again before act().";
  return message.includes(nextStep) ? message : `${message} ${nextStep}`;
}

function execFailure(error: unknown): BrowserExecResult {
  return {
    ok: false,
    logs: [],
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: appendExecNextStep(error instanceof Error ? error.message : String(error)),
    },
  };
}

function profileUsesExistingSession(profileName: string | undefined): boolean {
  if (!profileName) {
    return false;
  }
  const config = getRuntimeConfig();
  const resolved = resolveBrowserConfig(config.browser, config);
  const profile = resolveProfile(resolved, profileName);
  return profile ? getBrowserProfileCapabilities(profile).usesChromeMcp : false;
}

function withProfilePath(baseUrl: string, profile?: string): string {
  return profile ? `${baseUrl}/exec?profile=${encodeURIComponent(profile)}` : `${baseUrl}/exec`;
}

/** Create the agent-side Browser script tool. */
export function createBrowserExecTool(opts: BrowserExecToolOptions = {}): AnyAgentTool {
  return {
    label: "Browser Exec",
    name: "browser_exec",
    resultContentSource: "network",
    description: describeBrowserExecTool(),
    parameters: BrowserExecToolSchema,
    outputSchema: BrowserExecToolOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      try {
        const params = args as Record<string, unknown>;
        const code = readStringParam(params, "code", { required: true, trim: false });
        let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;
        let node = readStringParam(params, "node");
        let profile = readStringParam(params, "profile");
        let targetId = readStringParam(params, "targetId");
        let pinnedTargetId: string | undefined;
        const requestedTimeoutMs = readPositiveIntegerParam(params, "timeoutMs", {
          message: "timeoutMs must be a positive integer.",
        });
        const timeoutMs = resolveBrowserExecTimeoutMs(requestedTimeoutMs);
        const bindingResult =
          opts.runToolBinding === undefined
            ? undefined
            : parseBrowserTabToolBinding(opts.runToolBinding);
        if (bindingResult && !bindingResult.ok) {
          throw new Error(`invalid browser run binding: ${bindingResult.error}`);
        }
        if (bindingResult?.ok) {
          const binding = bindingResult.binding;
          if (target && target !== binding.target) {
            throw new Error("browser_exec cannot override its run-bound target");
          }
          if (node && node !== binding.node) {
            throw new Error("browser_exec cannot override its run-bound node");
          }
          if (profile && profile !== binding.profile) {
            throw new Error("browser_exec cannot override its run-bound profile");
          }
          if (targetId && targetId !== binding.targetId) {
            throw new Error("browser_exec cannot override its run-bound tab target");
          }
          target = binding.target;
          node = binding.node;
          profile = binding.profile;
          targetId = binding.targetId;
          pinnedTargetId = binding.targetId;
        }
        if (node && target && target !== "node") {
          throw new Error('node is only supported with target="node".');
        }

        const sandboxBridgeUrl = normalizeOptionalString(opts.sandboxBridgeUrl)?.replace(/\/$/, "");
        const existingSession = profileUsesExistingSession(profile);
        if (existingSession && target === "sandbox") {
          throw new Error(
            `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
          );
        }
        if (existingSession && !target && sandboxBridgeUrl && !node) {
          target = "host";
        }
        const useSandbox = target === "sandbox" || (!target && !node && Boolean(sandboxBridgeUrl));
        if (useSandbox && !sandboxBridgeUrl) {
          throw new Error(
            'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
          );
        }
        if (!useSandbox && opts.allowHostControl === false) {
          throw new Error(
            target === "node" || node
              ? "Node browser control is disabled by sandbox policy."
              : "Host browser control is disabled by sandbox policy.",
          );
        }

        const body = {
          code,
          ...(profile ? { profile } : {}),
          ...(targetId ? { targetId } : {}),
          ...(pinnedTargetId ? { pinnedTargetId } : {}),
          timeoutMs,
        };
        const routeTimeoutMs =
          addTimerTimeoutGraceMs(timeoutMs, BROWSER_EXEC_TRANSPORT_SLACK_MS) ?? timeoutMs;
        let result: BrowserExecResult;
        if (useSandbox && sandboxBridgeUrl) {
          result = await fetchBrowserJson<BrowserExecResult>(
            withProfilePath(sandboxBridgeUrl, profile),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              timeoutMs: routeTimeoutMs,
              signal,
            },
          );
        } else {
          result = await callGatewayTool<BrowserExecResult>(
            BROWSER_REQUEST_GATEWAY_METHOD,
            {
              timeoutMs:
                addTimerTimeoutGraceMs(routeTimeoutMs, BROWSER_EXEC_TRANSPORT_SLACK_MS) ??
                routeTimeoutMs,
            },
            {
              method: "POST",
              path: "/exec",
              query: profile ? { profile } : undefined,
              body,
              timeoutMs: routeTimeoutMs,
              ...(target ? { target } : {}),
              ...(node ? { node } : {}),
            },
            { scopes: [...BROWSER_REQUEST_GATEWAY_SCOPES], signal },
          );
        }
        return jsonResult(result);
      } catch (error) {
        return jsonResult(execFailure(error));
      }
    },
  };
}
