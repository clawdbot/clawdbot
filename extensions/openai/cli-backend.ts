import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import { prepareOpenAICodexCliExecution } from "./openai-codex-cli-bridge.js";

const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_CLI_DEFAULT_MODEL_REF = "codex-cli/gpt-5.4";

export function buildOpenAICodexCliBackend(): CliBackendPlugin {
  return {
    id: "codex-cli",
    liveTest: {
      defaultModelRef: CODEX_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@openai/codex",
        binaryName: "codex",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "codex-config-overrides",
    defaultAuthProfileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    authEpochMode: "profile-only",
    prepareExecution: prepareOpenAICodexCliExecution,
    config: {
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "{sessionId}",
        "-c",
        'sandbox_mode="workspace-write"',
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
