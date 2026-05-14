import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const CODEX_CLI_DEFAULT_MODEL_REF = "codex-cli/gpt-5.5";
// Keep this in sync with MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION in the Codex plugin.
const CODEX_CLI_NPM_PACKAGE = "@openai/codex@0.130.0";

export function buildOpenAICodexCliBackend(): CliBackendPlugin {
  return {
    id: "codex-cli",
    liveTest: {
      defaultModelRef: CODEX_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: CODEX_CLI_NPM_PACKAGE,
        binaryName: "codex",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "codex-config-overrides",
    nativeToolMode: "always-on",
    config: {
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "-c",
        'service_tier="fast"',
        "--skip-git-repo-check",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "{sessionId}",
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        'service_tier="fast"',
        "--skip-git-repo-check",
      ],
      output: "jsonl",
      resumeOutput: "text",
      input: "arg",
      modelArg: "--model",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
      systemPromptFileConfigArg: "-c",
      systemPromptFileConfigKey: "model_instructions_file",
      systemPromptWhen: "first",
      imageArg: "--image",
      imageMode: "repeat",
      imagePathScope: "workspace",
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
