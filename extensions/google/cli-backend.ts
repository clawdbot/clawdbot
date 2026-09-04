import crypto from "node:crypto";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";
const GEMINI_ALLOWED_MCP_SERVERS_ARG = "--allowed-mcp-server-names";

type GeminiCliBackendConfig = CliBackendPlugin["config"];
type GeminiCliOutputMode = NonNullable<GeminiCliBackendConfig["output"]>;

function mapGeminiCliOutputFormat(value: string | undefined): GeminiCliOutputMode | undefined {
  if (value === "stream-json") {
    return "jsonl";
  }
  if (value === "json" || value === "text") {
    return value;
  }
  return undefined;
}

function readGeminiCliOutputFormat(args: readonly string[] | undefined): GeminiCliOutputMode {
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const arg = args?.[index];
    if (arg === "--output-format" || arg === "-o") {
      return mapGeminiCliOutputFormat(args?.[index + 1]) ?? "text";
    }
    const inline = arg?.startsWith("--output-format=")
      ? arg.slice("--output-format=".length)
      : arg?.startsWith("-o=")
        ? arg.slice("-o=".length)
        : undefined;
    const mapped = mapGeminiCliOutputFormat(inline);
    if (mapped) {
      return mapped;
    }
  }
  return "text";
}

function normalizeGeminiCliBackendConfig(config: GeminiCliBackendConfig): GeminiCliBackendConfig {
  const output = readGeminiCliOutputFormat(config.args);
  const resumeOutput = readGeminiCliOutputFormat(config.resumeArgs ?? config.args);
  const usesStreamJson = output === "jsonl" || resumeOutput === "jsonl";
  return {
    ...config,
    output,
    resumeOutput,
    jsonlDialect: usesStreamJson ? "gemini-stream-json" : undefined,
  };
}

function isGeminiAllowedMcpServersArg(arg: string): boolean {
  const [name] = arg.split("=", 1);
  if (!name?.startsWith("--")) {
    return false;
  }
  return name.slice(2).replaceAll(/[-_]/g, "").toLowerCase() === "allowedmcpservernames";
}

function resolveGeminiCliExecutionArgs(
  ctx: Parameters<NonNullable<CliBackendPlugin["resolveExecutionArgs"]>>[0],
): readonly string[] {
  if (!ctx.toolAvailability) {
    return ctx.baseArgs;
  }
  const terminatorIndex = ctx.baseArgs.indexOf("--");
  const optionArgs = terminatorIndex === -1 ? ctx.baseArgs : ctx.baseArgs.slice(0, terminatorIndex);
  const positionalArgs = terminatorIndex === -1 ? [] : ctx.baseArgs.slice(terminatorIndex);
  const args: string[] = [];
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg && isGeminiAllowedMcpServersArg(arg)) {
      if (!arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (arg !== undefined) {
      args.push(arg);
    }
  }

  // Gemini intersects file-based allowlists, where an empty intersection means
  // unrestricted. The argv override bypasses that merge and prevents MCP startup.
  const allowedServer = ctx.toolAvailability.openClaw.length > 0 ? "openclaw" : crypto.randomUUID();
  return [...args, GEMINI_ALLOWED_MCP_SERVERS_ARG, allowedServer, ...positionalArgs];
}

export function buildGoogleGeminiCliBackend(): CliBackendPlugin {
  return {
    id: "google-gemini-cli",
    modelProvider: "google",
    liveTest: {
      defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@google/gemini-cli",
        binaryName: "gemini",
      },
    },
    // Gemini's published bundle owns inference; optional keychain/PTY modules
    // are auth and tool integrations, not the inference transport.
    runtimeArtifact: {
      kind: "bundled-package-tree",
      packageName: "@google/gemini-cli",
      entrypoint: "command",
      exactToolAvailabilityVersionPolicy: {
        stableMinimum: "0.39.1",
        prereleaseMinimums: {
          preview: "0.40.0-preview.3",
          nightly: "0.41.0-nightly.20260427.g42587de73",
        },
      },
    },
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    // Gemini compresses and persists its native history before requests; a second
    // compactor would require API auth outside the CLI and discard its resume binding.
    ownsNativeCompaction: true,
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "prepare-execution",
    authEpochMode: "profile-only",
    normalizeConfig: normalizeGeminiCliBackendConfig,
    resolveExecutionArgs: resolveGeminiCliExecutionArgs,
    prepareExecution: async (ctx) => {
      const { prepareGeminiCliExecution } = await import("./cli-backend-auth.runtime.js");
      const privateContext = ctx as typeof ctx & {
        authCredential?: unknown;
        isolatedCompletionCwd?: string;
        isolatedCompletionModelId?: string;
        isolatedCompletionPrompt?: string;
        isolatedCompletionSystemPrompt?: string;
      };
      return await prepareGeminiCliExecution(
        {
          agentDir: ctx.agentDir,
          authProfileId: ctx.authProfileId,
          workspaceDir: ctx.workspaceDir,
          baseEnv: ctx.env,
          isolatedCompletionCwd: privateContext.isolatedCompletionCwd,
          systemSettingsPath:
            ctx.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
          toolAvailability: ctx.toolAvailability,
          // Gemini owns a native per-process system-prompt file. Consume the private
          // core bridge without making isolated completion a public CLI SDK contract.
          isolatedCompletionModelId: privateContext.isolatedCompletionModelId,
          isolatedCompletionPrompt: privateContext.isolatedCompletionPrompt,
          isolatedCompletionSystemPrompt: privateContext.isolatedCompletionSystemPrompt,
        },
        privateContext.authCredential,
      );
    },
    config: {
      command: "gemini",
      args: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
      resumeArgs: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--resume",
        "{sessionId}",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
      output: "jsonl",
      input: "arg",
      jsonlDialect: "gemini-stream-json",
      imageArg: "@",
      imagePathScope: "workspace",
      modelArg: "--model",
      modelAliases: GEMINI_MODEL_ALIASES,
      sessionMode: "existing",
      sessionIdFields: ["session_id", "sessionId"],
      serialize: true,
    },
  };
}
