/**
 * Browser agent tool registration.
 *
 * Builds the model-facing browser tool, chooses sandbox/host/node routing, and
 * maps high-level actions onto browser control client calls.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { parseBrowserTabToolBinding } from "./browser-tool-binding.js";
import { describeBrowserTool } from "./browser-tool-description.js";
import { createBrowserToolExecutor, type BrowserToolOptions } from "./browser-tool-executor.js";
import type { AnyAgentTool } from "./browser-tool.runtime.js";
import {
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  getBrowserProfileCapabilities,
  getRuntimeConfig,
  resolveBrowserConfig,
  readStringParam,
  readStringValue,
  resolveBrowserToolCapabilities,
  resolveProfile,
} from "./browser-tool.runtime.js";
import { finalizeBrowserStewardRuntimeParams } from "./browser/browser-steward-approval.js";
import { prepareBrowserStewardToolParams } from "./browser/browser-steward-tool-params.js";
import { readActRequestParam } from "./browser/browser-tool-input.js";

export { prepareBrowserStewardToolParams };

function withBrowserTabDetails(
  result: AgentToolResult<unknown>,
  fallbackTargetId?: unknown,
): AgentToolResult<unknown> {
  // Control UI browser-tab preview card metadata; UI-only, replay strips details.
  try {
    const details = asNullableRecord(result.details);
    if (
      !details ||
      details.ok === false ||
      details.isError === true ||
      (Array.isArray(details.results) &&
        details.results.some((entry) => asNullableRecord(entry)?.ok === false)) ||
      asNullableRecord(details.aborted)?.reason === "closed"
    ) {
      return result;
    }
    const targetId = readStringValue(details.targetId) ?? readStringValue(fallbackTargetId);
    if (!targetId) {
      return result;
    }
    const url = readStringValue(details.url);
    const title = readStringValue(details.title);
    return {
      ...result,
      details: {
        ...details,
        browserTab: {
          targetId: truncateUtf16Safe(targetId, 128),
          ...(url ? { url: truncateUtf16Safe(url, 2048) } : {}),
          ...(title ? { title: truncateUtf16Safe(title, 512) } : {}),
        },
      },
    };
  } catch {
    return result;
  }
}

/** Create the Browser tool exposed to agents. */
export function createBrowserTool(opts?: BrowserToolOptions): AnyAgentTool {
  const bindingResult =
    opts?.runToolBinding === undefined
      ? undefined
      : parseBrowserTabToolBinding(opts.runToolBinding);
  if (bindingResult && !bindingResult.ok) {
    throw new Error(`invalid browser run binding: ${bindingResult.error}`);
  }
  const capabilities =
    opts?.toolCapabilities ??
    (() => {
      const config = getRuntimeConfig();
      const boundProfile =
        bindingResult?.ok && bindingResult.binding.target === "host"
          ? resolveProfile(
              resolveBrowserConfig(config.browser, config),
              bindingResult.binding.profile,
            )
          : undefined;
      return resolveBrowserToolCapabilities({
        tabBound: bindingResult?.ok,
        evaluateEnabled: config.browser?.evaluateEnabled !== false,
        ...(boundProfile
          ? { profileCapabilities: getBrowserProfileCapabilities(boundProfile) }
          : {}),
      });
    })();
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  const tool: AnyAgentTool = {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserTool({ targetDefault, hostHint, capabilities }),
    parameters: createBrowserToolSchema(capabilities),
    outputSchema: BrowserToolOutputSchema,
    prepareBeforeToolCallParams: async (params, context) =>
      await prepareBrowserStewardToolParams({
        input: params,
        agentSessionKey: opts?.agentSessionKey,
        agentId: opts?.agentId,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
        allowHostControl: opts?.allowHostControl,
        ...(bindingResult?.ok ? { runToolBinding: bindingResult.binding } : {}),
        approvalAuthority: opts?.approvalAuthority,
        signal: context.signal,
      }),
    finalizeBeforeToolCallParams: (params, preparedParams) =>
      finalizeBrowserStewardRuntimeParams(params, preparedParams, opts?.approvalAuthority),
    execute: createBrowserToolExecutor({
      opts,
      binding: bindingResult?.ok ? bindingResult.binding : undefined,
      capabilities,
    }),
  };
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      const params = asNullableRecord(args[1]) ?? {};
      const action = readStringParam(params, "action", { required: true });
      const actRequest = action === "act" ? readActRequestParam(params) : undefined;
      const targetId =
        actRequest?.targetId ??
        params.targetId ??
        (bindingResult?.ok ? bindingResult.binding.targetId : undefined);
      return [
        "open",
        "focus",
        "navigate",
        "screenshot",
        "snapshot",
        "text",
        "requests",
        "errors",
        "console",
        "emulate",
        "act",
      ].includes(action) && actRequest?.kind !== "close"
        ? withBrowserTabDetails(result, targetId)
        : result;
    },
  };
}
