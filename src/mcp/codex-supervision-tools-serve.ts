/**
 * Compatibility MCP server for the retired Codex Supervisor tool names.
 *
 * The tools are resolved from the bundled Codex plugin so MCP and agent calls
 * share one implementation and one app-server client pool.
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { ensureStandalonePluginToolRegistryLoaded, resolvePluginTools } from "../plugins/tools.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

const LEGACY_TOOL_NAMES = [
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "codex_session_send",
  "codex_session_interrupt",
] as const;
const LEGACY_TOOL_NAME_SET = new Set<string>(LEGACY_TOOL_NAMES);
const TRUSTED_STANDALONE_MCP_OWNER_CONTEXT = { senderIsOwner: true as const };

function withCodexSupervisionEnabled(config: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(normalizePluginTargetConfig(config, "codex")) as OpenClawConfig &
    Record<string, unknown>;
  const plugins = (next.plugins ??= {}) as Record<string, unknown>;
  plugins.enabled = true;
  const deny = Array.isArray(plugins.deny)
    ? plugins.deny.filter((entry) => entry !== "codex")
    : undefined;
  if (deny) {
    plugins.deny = deny;
  }
  if (Array.isArray(plugins.allow) && !plugins.allow.includes("codex")) {
    plugins.allow = [...plugins.allow, "codex"];
  }
  const entries = (plugins.entries ??= {}) as Record<string, unknown>;
  const codex = (entries.codex ??= {}) as Record<string, unknown>;
  codex.enabled = true;
  const codexConfig = (codex.config ??= {}) as Record<string, unknown>;
  const supervision = (codexConfig.supervision ??= {}) as Record<string, unknown>;
  supervision.enabled = true;
  if (process.env.OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS === "1") {
    supervision.allowRawTranscripts = true;
  }
  if (process.env.OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS === "1") {
    supervision.allowWriteControls = true;
  }
  return next;
}

function resolveCodexSupervisionTools(config: OpenClawConfig): AnyAgentTool[] {
  const context = {
    config,
    runtimeConfig: config,
    getRuntimeConfig: () => config,
    // This local stdio bridge is operator-launched and intentionally receives
    // the same trusted owner capability as an owner-authenticated agent turn.
    ...TRUSTED_STANDALONE_MCP_OWNER_CONTEXT,
  };
  const toolAllowlist = [...LEGACY_TOOL_NAMES];
  const runtimeRegistry = ensureStandalonePluginToolRegistryLoaded({
    context,
    toolAllowlist,
    env: process.env,
  });
  return resolvePluginTools({
    context,
    toolAllowlist,
    suppressNameConflicts: true,
    runtimeRegistry,
    env: process.env,
  }).filter((tool) => LEGACY_TOOL_NAME_SET.has(tool.name));
}

function requireCompleteCodexSupervisionToolSet(tools: readonly AnyAgentTool[]): void {
  const loadedNames = new Set(tools.map((tool) => tool.name));
  const missing = LEGACY_TOOL_NAMES.filter((name) => !loadedNames.has(name));
  if (
    missing.length === 0 &&
    loadedNames.size === LEGACY_TOOL_NAMES.length &&
    tools.length === LEGACY_TOOL_NAMES.length
  ) {
    return;
  }
  throw new Error(
    `Codex supervision MCP could not load the official @openclaw/codex plugin tools (missing: ${missing.join(", ") || "none"}). Install or update @openclaw/codex, then enable Codex supervision.`,
  );
}

export function createCodexSupervisionToolsMcpServer(
  params: { config?: OpenClawConfig; tools?: AnyAgentTool[] } = {},
): Server {
  const config = withCodexSupervisionEnabled(params.config ?? getRuntimeConfig());
  const tools = params.tools ?? resolveCodexSupervisionTools(config);
  requireCompleteCodexSupervisionToolSet(tools);
  return createToolsMcpServer({ name: "openclaw-codex-supervisor", tools });
}

export async function serveCodexSupervisionToolsMcp(): Promise<void> {
  routeLogsToStderr();
  const config = withCodexSupervisionEnabled(getRuntimeConfig());
  const tools = resolveCodexSupervisionTools(config);
  await connectToolsMcpServerToStdio(createCodexSupervisionToolsMcpServer({ config, tools }), {
    onShutdown: disposeRegisteredAgentHarnesses,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveCodexSupervisionToolsMcp().catch((error: unknown) => {
    process.stderr.write(`codex-supervisor-serve: ${formatErrorMessage(error)}\n`);
    process.exit(1);
  });
}
