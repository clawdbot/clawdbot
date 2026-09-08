import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isWebFetchProviderConfigured,
  listWebFetchProviders,
  resolveWebFetchDefinition,
} from "../../web-fetch/runtime.js";
import {
  isWebSearchProviderConfigured,
  listWebSearchProviders,
  runWebSearch,
} from "../../web-search/runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import {
  getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargets,
} from "../command-secret-targets.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { emitJsonOrText, formatEnvelopeForText } from "./output.js";
import {
  parseOptionalPositiveInteger,
  registerLocalProvidersCommand,
  resolveLocalCapabilityRuntimeConfig,
} from "./shared.js";

function describeWebResultFailure(result: Record<string, unknown>): string | undefined {
  const statusCode =
    typeof result.statusCode === "number" && Number.isFinite(result.statusCode)
      ? result.statusCode
      : undefined;
  const error = result.error;
  const errorMessage =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : undefined;
  if (result.ok !== false && (statusCode === undefined || statusCode < 400) && !errorMessage) {
    return undefined;
  }
  return (
    errorMessage ??
    (statusCode ? `provider returned status ${statusCode}` : "provider reported failure")
  );
}

async function runWebSearchCommand(params: { query: string; provider?: string; limit?: number }) {
  const rawConfig = getRuntimeConfig();
  const scopedTargets = getCapabilityWebSearchCommandSecretTargets(rawConfig, {
    providerId: params.provider,
  });
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer web search",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
    ...(scopedTargets.forcedActivePaths
      ? { forcedActivePaths: scopedTargets.forcedActivePaths }
      : {}),
    ...(scopedTargets.optionalActivePaths
      ? { optionalActivePaths: scopedTargets.optionalActivePaths }
      : {}),
    config: rawConfig,
  });
  const result = await runWebSearch({
    config: cfg,
    providerId: params.provider,
    args: {
      query: params.query,
      count: params.limit,
      limit: params.limit,
    },
  });
  const error = describeWebResultFailure(result.result);
  return {
    ok: error === undefined,
    capability: "web.search",
    transport: "local" as const,
    provider: result.provider,
    attempts: [],
    outputs: [{ result: result.result }],
    ...(error ? { error } : {}),
  } satisfies CapabilityEnvelope;
}

async function runWebFetchCommand(params: { url: string; provider?: string; format?: string }) {
  const rawConfig = getRuntimeConfig();
  const scopedTargets = getCapabilityWebFetchCommandSecretTargets(rawConfig, {
    providerId: params.provider,
  });
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer web fetch",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
    ...(scopedTargets.forcedActivePaths
      ? { forcedActivePaths: scopedTargets.forcedActivePaths }
      : {}),
    ...(scopedTargets.optionalActivePaths
      ? { optionalActivePaths: scopedTargets.optionalActivePaths }
      : {}),
    config: rawConfig,
  });
  const resolved = resolveWebFetchDefinition({
    config: cfg,
    providerId: params.provider,
  });
  if (!resolved) {
    throw new Error("web.fetch is disabled or no provider is available.");
  }
  const result = await resolved.definition.execute({
    url: params.url,
    format: params.format,
  });
  const error = describeWebResultFailure(result);
  return {
    ok: error === undefined,
    capability: "web.fetch",
    transport: "local" as const,
    provider: resolved.provider.id,
    attempts: [],
    outputs: [{ result }],
    ...(error ? { error } : {}),
  } satisfies CapabilityEnvelope;
}

export function registerWebCapabilityCommands(capability: Command): void {
  const web = capability.command("web").description("Web capabilities");

  web
    .command("search")
    .description("Run web search")
    .requiredOption("--query <text>", "Search query")
    .option("--provider <id>", "Provider id")
    .option("--limit <n>", "Result limit")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      let failed = false;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runWebSearchCommand({
          query: String(opts.query),
          provider: opts.provider as string | undefined,
          limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
        });
        failed = !result.ok;
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
      if (failed) {
        defaultRuntime.exit(1);
      }
    });

  web
    .command("fetch")
    .description("Fetch one URL")
    .requiredOption("--url <url>", "URL")
    .option("--provider <id>", "Provider id")
    .option("--format <format>", "Format hint")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      let failed = false;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runWebFetchCommand({
          url: String(opts.url),
          provider: opts.provider as string | undefined,
          format: opts.format as string | undefined,
        });
        failed = !result.ok;
        emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
      });
      if (failed) {
        defaultRuntime.exit(1);
      }
    });

  registerLocalProvidersCommand(
    web,
    "List web providers",
    (cfg, agentId) => {
      const agentDir = resolveAgentDir(cfg, agentId);
      const selectedSearchProvider =
        typeof cfg.tools?.web?.search?.provider === "string"
          ? normalizeLowercaseStringOrEmpty(cfg.tools.web.search.provider)
          : "";
      const selectedFetchProvider =
        typeof cfg.tools?.web?.fetch?.provider === "string"
          ? normalizeLowercaseStringOrEmpty(cfg.tools.web.fetch.provider)
          : "";
      return {
        search: listWebSearchProviders({ config: cfg }).map((provider) => ({
          available: true,
          configured: isWebSearchProviderConfigured({ provider, config: cfg, agentDir }),
          selected: provider.id === selectedSearchProvider,
          id: provider.id,
          envVars: provider.envVars,
        })),
        fetch: listWebFetchProviders({ config: cfg }).map((provider) => ({
          available: true,
          configured: isWebFetchProviderConfigured({ provider, config: cfg }),
          selected: provider.id === selectedFetchProvider,
          id: provider.id,
          envVars: provider.envVars,
        })),
      };
    },
    (value) => JSON.stringify(value, null, 2),
  );
}
