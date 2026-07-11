import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";

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
    },
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    nativeToolMode: "always-on",
    authEpochMode: "profile-only",
    normalizeConfig: normalizeGeminiCliBackendConfig,
    prepareExecution: async (ctx) => {
      const { prepareGeminiCliAuthHome } = await import("./cli-backend-auth.runtime.js");
      return await prepareGeminiCliAuthHome(
        {
          agentDir: ctx.agentDir,
          authProfileId: ctx.authProfileId,
          systemSettingsPath:
            (ctx as typeof ctx & { env?: Record<string, string> }).env
              ?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
        },
        (ctx as typeof ctx & { authCredential?: unknown }).authCredential,
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
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
