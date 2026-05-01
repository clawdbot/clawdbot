import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite-preview",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";

export function buildGoogleGeminiCliBackend(): CliBackendPlugin {
  return {
    id: "google-gemini-cli",
    liveTest: {
      defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@google/gemini-cli",
        binaryName: "gemini",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    nativeToolMode: "always-on",
    config: {
      command: "gemini",
      args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "--output-format",
        "json",
        "--prompt",
        "{prompt}",
      ],
      output: "json",
      input: "arg",
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
