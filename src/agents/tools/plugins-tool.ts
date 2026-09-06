import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import type { PluginRuntimeApplication } from "../../plugins/lifecycle.js";
import type { listManagedPlugins } from "../../plugins/management-service.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readToolStringParam, ToolInputError, type AnyAgentTool } from "./common.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

const PLUGINS_TOOL_RESULT_MAX_BYTES = 3_840;

function pluginsToolResult(payload: Record<string, unknown>) {
  const size = boundedJsonUtf8Bytes(payload, PLUGINS_TOOL_RESULT_MAX_BYTES);
  if (
    size.complete &&
    Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") <= PLUGINS_TOOL_RESULT_MAX_BYTES
  ) {
    return jsonResult(payload);
  }
  const details = isRecord(payload.details) ? payload.details : undefined;
  const runtime = isRecord(payload.runtime)
    ? payload.runtime
    : isRecord(details?.runtime)
      ? details.runtime
      : undefined;
  const phase = runtime?.phase;
  // A review token is useful only alongside the complete capability review.
  // Keep the publication outcome, but omit oversized details as a whole.
  return jsonResult({
    ok: payload.ok !== false,
    runtime:
      runtime && typeof runtime.generation === "number"
        ? {
            generation: runtime.generation,
            committed:
              typeof runtime.committed === "boolean" ? runtime.committed : payload.ok !== false,
            phase:
              phase === "prepare" ||
              phase === "drain" ||
              phase === "activate" ||
              phase === "dispose"
                ? phase
                : undefined,
          }
        : undefined,
    detailsOmitted: "response_budget_exceeded",
    next: "Use the Control UI Plugins page for the complete result and any required capability review. Narrow inventory or search queries before retrying; do not repeat a completed mutation.",
  });
}

const PluginsToolSchema = Type.Object(
  {
    action: stringEnum([
      "list",
      "inspect",
      "search",
      "install",
      "enable",
      "disable",
      "uninstall",
      "reload",
    ]),
    pluginId: Type.Optional(Type.String()),
    query: Type.Optional(
      Type.String({ description: "Filter the plugin inventory or search published plugins." }),
    ),
    source: Type.Optional(stringEnum(["official", "clawhub", "local"])),
    packageName: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    path: Type.Optional(Type.String({ description: "Local plugin path for installation." })),
    link: Type.Optional(Type.Boolean()),
    reviewToken: Type.Optional(
      Type.String({ description: "Capability review acknowledged by the operator." }),
    ),
    acknowledgeInstallPolicyWarning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export function createPluginsTool(): AnyAgentTool {
  const runtimeRefresh = captureAgentPluginRuntimeRefresh();
  return {
    name: "plugins",
    label: "Plugins",
    description:
      "Inspect, install, enable, disable, uninstall, or reload plugins without restarting the Gateway. After editing local plugin files, reload the plugin to activate them. Once running code cells settle, changes refresh this session at the next model step; finish the current program before using changed tools. Preserved native sessions keep their original tool names and schemas; use a new session for new ones.",
    parameters: PluginsToolSchema,
    execute: async (_toolCallId, args, signal) => {
      runtimeRefresh.assertCurrent();
      const params = asNonArrayRecord(args);
      const action = readToolStringParam(params, "action", { required: true });
      const required = (key: string) => readToolStringParam(params, key, { required: true });
      const reviewToken = readToolStringParam(params, "reviewToken");
      const consent = reviewToken ? { acknowledgeCapabilities: { reviewToken } } : {};
      let method: string;
      let request: Record<string, unknown>;
      switch (action) {
        case "list":
          method = "plugins.list";
          request = {};
          break;
        case "inspect":
        case "uninstall":
        case "reload":
          method = `plugins.${action}`;
          request = { pluginId: required("pluginId"), ...(action === "reload" ? consent : {}) };
          break;
        case "search":
          method = "plugins.search";
          request = { query: required("query"), limit: 10 };
          break;
        case "enable":
        case "disable":
          method = "plugins.setEnabled";
          request = { pluginId: required("pluginId"), enabled: action === "enable", ...consent };
          break;
        case "install": {
          const source = required("source");
          if (!["official", "clawhub", "local"].includes(source)) {
            throw new ToolInputError(`Unknown plugin installation source: ${source}`);
          }
          const version = readToolStringParam(params, "version");
          method = "plugins.install";
          request = {
            source,
            ...(source === "official"
              ? { pluginId: required("pluginId"), ...(version ? { version } : {}) }
              : source === "local"
                ? { path: required("path"), ...(params.link === true ? { link: true } : {}) }
                : { packageName: required("packageName"), ...(version ? { version } : {}) }),
            ...(params.acknowledgeInstallPolicyWarning === true
              ? { acknowledgeInstallPolicyWarning: true }
              : {}),
            ...consent,
          };
          break;
        }
        default:
          throw new ToolInputError(`Unknown plugin action: ${action}`);
      }
      let result: Record<string, unknown> & { runtime?: PluginRuntimeApplication };
      try {
        result = await callAgentToolGatewayRequest({
          method,
          params: request,
          signal,
          timeoutMs: null,
        });
      } catch (error) {
        if (!(error instanceof GatewayClientRequestError)) {
          throw error;
        }
        const runtime =
          isRecord(error.details) && isRecord(error.details.runtime)
            ? error.details.runtime
            : undefined;
        const refresh =
          runtime?.committed === true &&
          typeof runtime.operationId === "string" &&
          typeof runtime.generation === "number" &&
          Array.isArray(runtime.pluginIds) &&
          runtime.pluginIds.every((id) => typeof id === "string") &&
          runtimeRefresh.request({
            operationId: runtime.operationId,
            generation: runtime.generation,
            pluginIds: runtime.pluginIds,
          });
        return {
          ...pluginsToolResult({
            ok: false,
            code: error.gatewayCode,
            error: error.message,
            details: error.details,
          }),
          isError: true,
          ...(refresh ? { terminate: true } : {}),
        };
      }
      if (action === "list") {
        // SAFETY: The list action dispatches only plugins.list, whose handler returns listManagedPlugins.
        const inventory = result as Awaited<ReturnType<typeof listManagedPlugins>>;
        const query = readToolStringParam(params, "query")?.toLowerCase();
        const matching = inventory.plugins.filter(
          (plugin) =>
            !query ||
            [plugin.id, plugin.name, plugin.description].some((value) =>
              value?.toLowerCase().includes(query),
            ),
        );
        return pluginsToolResult({
          plugins: matching.slice(0, 20).map(({ id, state, version }) => ({ id, state, version })),
          matching: matching.length,
          omitted: Math.max(0, matching.length - 20),
          mutationAllowed: inventory.mutationAllowed,
          next: "Use query to narrow this inventory or inspect a pluginId for details.",
        });
      }
      const refresh = result.runtime && runtimeRefresh.request(result.runtime);
      return { ...pluginsToolResult(result), ...(refresh ? { terminate: true } : {}) };
    },
  };
}
