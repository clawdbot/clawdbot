// Public operation dispatcher. Parsing and mutation helpers live in focused modules.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import { isReservedSystemAgentId } from "./agent-id.js";
import { SYSTEM_AGENT_AUDIT_STORE_LABEL } from "./audit.js";
import {
  CONFIG_GET_OUTPUT_MAX_CHARS,
  CONFIG_SCHEMA_CHILDREN_MAX,
  applyPersistentOperation,
  assertConfigWriteDoesNotBypassInferenceVerification,
  createNoExitRuntime,
  executePluginInstall,
  executeSetDefaultModel,
  executeSetup,
  formatChannelDocsUrl,
  formatConfigValidationLine,
  formatGatewayStatusLine,
  isPluginBackingDefaultInferenceRoute,
  loadOverviewForOperation,
  readConfigFileSnapshotLazy,
  readConfigValueAtPath,
  redactConfigValue,
  resolveChannelSetupState,
  resolveTuiAgentId,
  runConfigSetOperation,
  runGatewayLifecycle,
  type ExecuteOptions,
} from "./operations-execution-helpers.js";
import type { SystemAgentOperation, SystemAgentOperationResult } from "./operations-parse.js";

const loadOverviewModule = async () => await import("./overview.js");

/** Execute a parsed OpenClaw operation after applying approval gates and audit logging. */
export async function executeSystemAgentOperation(
  operation: SystemAgentOperation,
  runtime: RuntimeEnv,
  opts: ExecuteOptions = {},
): Promise<SystemAgentOperationResult> {
  switch (operation.kind) {
    case "none":
      runtime.log(operation.message);
      return { applied: false, exitsInteractive: operation.message.includes("Bye.") };
    case "overview": {
      const overview = await loadOverviewForOperation(opts.deps);
      if (opts.deps?.formatOverview) {
        runtime.log(opts.deps.formatOverview(overview));
      } else {
        const { formatSystemAgentOverview } = await loadOverviewModule();
        runtime.log(formatSystemAgentOverview(overview));
      }
      return { applied: false };
    }
    case "agents": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          "Agents:",
          ...overview.agents.map((agent) => {
            const bits = [
              agent.id,
              agent.isDefault ? "default" : undefined,
              agent.name ? `name=${agent.name}` : undefined,
              agent.workspace
                ? `workspace=${shortenHomePath(resolveUserPath(agent.workspace))}`
                : undefined,
            ].filter(Boolean);
            return `  - ${bits.join(" | ")}`;
          }),
        ].join("\n"),
      );
      return { applied: false };
    }
    case "models": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          `Default model: ${overview.defaultModel ?? "not configured"}`,
          `Codex: ${overview.tools.codex.found ? "found" : "not found"}`,
          `Claude Code: ${overview.tools.claude.found ? "found" : "not found"}`,
          `Gemini CLI: ${overview.tools.gemini.found ? "found" : "not found"}`,
          `OpenAI key: ${overview.tools.apiKeys.openai ? "found" : "not found"}`,
          `Anthropic key: ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "plugin-list": {
      const runPluginsList =
        opts.deps?.runPluginsList ??
        (async (pluginRuntime: RuntimeEnv) => {
          const { runPluginsListCommand } = await import("../cli/plugins-list-command.js");
          await runPluginsListCommand({}, pluginRuntime);
        });
      await runPluginsList(runtime);
      return { applied: false };
    }
    case "plugin-search": {
      const runPluginsSearch =
        opts.deps?.runPluginsSearch ??
        (async (query: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginsSearchCommand } = await import("../cli/plugins-search-command.js");
          await runPluginsSearchCommand(query, {}, pluginRuntime);
        });
      await runPluginsSearch(operation.query, runtime);
      return { applied: false };
    }
    case "audit":
      runtime.log(`Audit state: ${SYSTEM_AGENT_AUDIT_STORE_LABEL}`);
      runtime.log("Only applied writes/actions are recorded; discovery stays quiet.");
      return { applied: false };
    case "config-validate": {
      const snapshot = await readConfigFileSnapshotLazy();
      runtime.log(formatConfigValidationLine(snapshot));
      return { applied: false };
    }
    case "config-get": {
      const snapshot = await readConfigFileSnapshotLazy();
      if (!snapshot.exists) {
        runtime.log(`Config missing: ${shortenHomePath(snapshot.path)}`);
        return { applied: false };
      }
      const cfg = snapshot.valid
        ? (snapshot.sourceConfig ?? snapshot.config)
        : snapshot.sourceConfig;
      const lookup = readConfigValueAtPath(cfg ?? {}, operation.path);
      if (!lookup.found) {
        runtime.log(
          `${operation.path}: not set. Use \`config schema ${operation.path}\` to see what is allowed.`,
        );
        return { applied: false };
      }
      const redacted = redactConfigValue(lookup.value, operation.path);
      const rendered = JSON.stringify(redacted, null, 2) ?? "null";
      runtime.log(
        rendered.length > CONFIG_GET_OUTPUT_MAX_CHARS
          ? `${operation.path} = ${truncateUtf16Safe(rendered, CONFIG_GET_OUTPUT_MAX_CHARS)}\n… (truncated)`
          : `${operation.path} = ${rendered}`,
      );
      return { applied: false };
    }
    case "config-schema": {
      const { buildConfigSchema, lookupConfigSchema } = await import("../config/schema.js");
      const response = buildConfigSchema();
      const path = operation.path ?? ".";
      const result = lookupConfigSchema(response, path);
      if (!result) {
        runtime.log(`No config schema at "${path}". Try \`config schema .\` for the root keys.`);
        return { applied: false };
      }
      const schema = result.schema as {
        type?: string | string[];
        description?: string;
        enum?: unknown[];
        default?: unknown;
      };
      const childLines = result.children.slice(0, CONFIG_SCHEMA_CHILDREN_MAX).map((child) => {
        const type = Array.isArray(child.type) ? child.type.join("|") : (child.type ?? "object");
        const bits = [
          type,
          child.required ? "required" : undefined,
          child.hasChildren ? "…" : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return `  - ${child.path} (${bits})`;
      });
      runtime.log(
        [
          `Schema for ${result.path === "" ? "." : result.path}:`,
          schema.type
            ? `type: ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`
            : undefined,
          schema.description ? `description: ${schema.description}` : undefined,
          schema.enum
            ? `allowed values: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`
            : undefined,
          schema.default !== undefined ? `default: ${JSON.stringify(schema.default)}` : undefined,
          ...(childLines.length > 0 ? ["keys:", ...childLines] : []),
          result.children.length > CONFIG_SCHEMA_CHILDREN_MAX
            ? `… +${result.children.length - CONFIG_SCHEMA_CHILDREN_MAX} more keys`
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );
      return { applied: false };
    }
    case "channel-list": {
      // Use the same discovery as channel setup (bundled plugins + trusted
      // catalog), so the listing matches what `connect <channel>` can configure
      // even before any plugin registry is active.
      const { resolved } = await resolveChannelSetupState(opts.deps);
      const entries = resolved.entries.toSorted((a, b) => a.id.localeCompare(b.id));
      runtime.log(
        [
          "Channels:",
          ...entries.map(
            (entry) => `  - ${entry.id}${entry.meta.label ? ` (${entry.meta.label})` : ""}`,
          ),
          "",
          "Say `connect <channel>` to walk through setup (for example `connect telegram`).",
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-info": {
      const { cfg, installedPlugins, resolved, isConfigured } = await resolveChannelSetupState(
        opts.deps,
      );
      const channel = operation.channel.toLowerCase();
      const entry = resolved.entries.find((candidate) => candidate.id === channel);
      if (!entry) {
        const knownIds = resolved.entries.map((candidate) => candidate.id).toSorted();
        runtime.log(
          [
            `Unknown channel: ${channel}`,
            `Known channels: ${knownIds.length > 0 ? knownIds.join(", ") : "none"}`,
          ].join("\n"),
        );
        return { applied: false };
      }
      const installed =
        installedPlugins.some((plugin) => plugin.id === entry.id) ||
        resolved.installedCatalogById.has(entry.id);
      runtime.log(
        [
          `${entry.meta.label} (${entry.id})`,
          entry.meta.blurb,
          `Configured: ${isConfigured(cfg, entry.id) ? "yes" : "no"}`,
          `Installed: ${installed ? "yes" : "no"}`,
          `Docs: ${formatChannelDocsUrl(entry.meta.docsPath)}`,
          "",
          `Say \`connect ${entry.id}\` to set it up here, or \`open channel wizard for ${entry.id}\` for the masked terminal wizard.`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-setup":
      // Channel setup is a multi-step wizard; only interactive OpenClaw (TUI
      // chat bridge or the gateway chat) can host it. One-shot mode points at
      // the guided paths.
      runtime.log(
        [
          `Connecting ${operation.channel} needs an interactive session.`,
          "Run `openclaw setup` and say `connect " + operation.channel + "`,",
          "or run `openclaw channels add` for the terminal wizard.",
        ].join("\n"),
      );
      return { applied: false };
    case "model-setup":
      runtime.log(
        [
          "Changing model providers must happen outside the inference session that powers OpenClaw.",
          "Exit OpenClaw and run `openclaw onboard`; it stages credentials, live-tests the candidate route, and saves only a passing setup.",
        ].join("\n"),
      );
      return { applied: false };
    case "open-setup": {
      const command =
        operation.target === "guided"
          ? "openclaw onboard"
          : operation.target === "classic"
            ? "openclaw onboard --classic"
            : `openclaw channels add${operation.channel ? ` --channel ${operation.channel}` : ""}`;
      runtime.log(
        `One-shot mode cannot open an interactive wizard. Run \`${command}\` in a terminal.`,
      );
      return { applied: false };
    }
    case "setup":
      return await executeSetup(operation, runtime, opts);
    case "config-set":
      await assertConfigWriteDoesNotBypassInferenceVerification(operation);
      return await applyPersistentOperation({
        auditOperation: "config.set",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return { summary: `Set config ${operation.path}`, details: { path: operation.path } };
        },
      });
    case "config-set-ref":
      await assertConfigWriteDoesNotBypassInferenceVerification(operation);
      return await applyPersistentOperation({
        auditOperation: "config.setRef",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return {
            summary: `Set config ${operation.path} SecretRef`,
            details: {
              path: operation.path,
              source: operation.source,
              provider: operation.provider ?? "default",
            },
          };
        },
      });
    case "plugin-install":
      return await executePluginInstall(operation, runtime, opts);
    case "plugin-uninstall": {
      if (await isPluginBackingDefaultInferenceRoute(operation.pluginId)) {
        const message = [
          `Uninstalling ${operation.pluginId} could remove the provider behind OpenClaw's own active inference route.`,
          `Exit OpenClaw and run \`openclaw plugins uninstall ${operation.pluginId}\` from a terminal.`,
        ].join("\n");
        runtime.log(message);
        return { applied: false, message };
      }
      const result = await applyPersistentOperation({
        auditOperation: "plugin.uninstall",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runPluginUninstall =
            ctx.deps?.runPluginUninstall ??
            (async (pluginId: string, pluginRuntime: RuntimeEnv) => {
              const { runPluginUninstallCommand } =
                await import("../cli/plugins-uninstall-command.js");
              await runPluginUninstallCommand(pluginId, {}, pluginRuntime);
            });
          await ctx.commit(async () => {
            // A concurrent config write can retarget the default route between
            // the pre-approval check and this commit; re-verify at the last
            // moment so the destructive removal never hits the active route.
            if (await isPluginBackingDefaultInferenceRoute(operation.pluginId)) {
              throw new Error(
                `Uninstall aborted: ${operation.pluginId} now backs the active inference route. Exit OpenClaw and run \`openclaw plugins uninstall ${operation.pluginId}\` from a terminal.`,
              );
            }
            await runPluginUninstall(operation.pluginId, createNoExitRuntime(ctx.runtime));
          });
          return {
            summary: `Uninstalled plugin ${operation.pluginId}`,
            details: { pluginId: operation.pluginId },
          };
        },
      });
      if (result.applied) {
        runtime.log("Restart the Gateway to apply plugin changes.");
      }
      return result;
    }
    case "create-agent": {
      if (isReservedSystemAgentId(operation.agentId)) {
        throw new Error(
          `Agent id "${normalizeAgentId(operation.agentId)}" is reserved for the system agent. Choose a different agent id.`,
        );
      }
      if (operation.model?.trim()) {
        throw new Error(
          "OpenClaw cannot save an explicit per-agent model until that new route can be live-tested. Retry without `model`; the new agent inherits the verified default, then use `set_default_model` with agentId to live-test and save its own model.",
        );
      }
      const workspace = resolveUserPath(operation.workspace ?? process.cwd());
      return await applyPersistentOperation({
        auditOperation: "agents.create",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runAgentsAdd =
            ctx.deps?.runAgentsAdd ??
            (await import("../commands/agents.commands.add.js")).agentsAddCommand;
          await ctx.commit(async () => {
            await runAgentsAdd(
              {
                name: operation.agentId,
                workspace,
                nonInteractive: true,
              },
              ctx.runtime,
              { hasFlags: true },
            );
          });
          return {
            summary: `Created agent ${operation.agentId}`,
            details: {
              agentId: operation.agentId,
              workspace,
            },
          };
        },
      });
    }
    case "doctor": {
      const runDoctor =
        opts.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
      await runDoctor(runtime, { nonInteractive: true });
      return { applied: false };
    }
    case "doctor-fix":
      runtime.log(
        "Doctor repairs can change the inference route that powers this session. Exit OpenClaw and run `openclaw doctor --fix` in a terminal.",
      );
      return { applied: false };
    case "status": {
      const { statusCommand } = await import("../commands/status.command.js");
      await statusCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "health": {
      const { healthCommand } = await import("../commands/health.js");
      await healthCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "gateway-status": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(formatGatewayStatusLine(overview));
      return { applied: false };
    }
    case "gateway-start":
      return await applyPersistentOperation({
        auditOperation: "gateway.start",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStart = ctx.deps?.runGatewayStart ?? (() => runGatewayLifecycle("start"));
          await ctx.commit(runGatewayStart);
          return { summary: "Started Gateway" };
        },
      });
    case "gateway-stop":
      return await applyPersistentOperation({
        auditOperation: "gateway.stop",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStop = ctx.deps?.runGatewayStop ?? (() => runGatewayLifecycle("stop"));
          await ctx.commit(runGatewayStop);
          return { summary: "Stopped Gateway" };
        },
      });
    case "gateway-restart":
      return await applyPersistentOperation({
        auditOperation: "gateway.restart",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayRestart =
            ctx.deps?.runGatewayRestart ?? (() => runGatewayLifecycle("restart"));
          const restarted = await ctx.commit(runGatewayRestart);
          if (restarted === false) {
            throw new Error("Gateway restart did not complete");
          }
          return { summary: "Restarted Gateway" };
        },
      });
    case "open-tui": {
      const agentId = await resolveTuiAgentId({
        requestedAgentId: operation.agentId,
        requestedWorkspace: operation.workspace,
        deps: opts.deps,
      });
      const session = agentId ? buildAgentMainSessionKey({ agentId }) : undefined;
      const runTui = opts.deps?.runTui ?? (await import("../tui/tui.js")).runTui;
      const result = await runTui({
        local: true,
        session,
        deliver: false,
        historyLimit: 200,
        ...(operation.agentDraft === "hatch"
          ? { message: t("wizard.finalize.bootstrapHatchMessage") }
          : {}),
      });
      if (result?.exitReason === "return-to-system-agent") {
        runtime.log(
          result.systemAgentMessage
            ? `[openclaw] returned from agent with request: ${result.systemAgentMessage}`
            : "[openclaw] returned from agent",
        );
        return { applied: false, returnToShell: true, nextInput: result.systemAgentMessage };
      }
      return { applied: false, exitsInteractive: true };
    }
    case "set-default-model":
      return await executeSetDefaultModel(operation, runtime, opts);
    default:
      return { applied: false };
  }
}
