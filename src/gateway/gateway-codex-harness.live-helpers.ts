export const EXPECTED_CODEX_MODELS_COMMAND_TEXT = [
  "Codex models:",
  "Available Codex models",
  "Available agent target:",
  "Available agent targets:",
  "opened an interactive trust prompt",
  "opened an interactive model-selection prompt",
  "running as Codex on `codex/",
  "currently running on `codex/",
  "stdin is not a terminal",
  "The local `codex models` entrypoint is interactive in this environment",
  "`codex models` did not run in this environment.",
  "`codex models` failed in this sandbox",
  "`codex models` could not be run in this sandbox.",
  "`codex models` is not runnable in this sandboxed session.",
  "I couldn’t get a direct `codex models` CLI listing because the local sandbox blocked that command.",
  "I couldn’t list all installed/available Codex models from the local CLI because the sandboxed `codex` command failed to start in this environment.",
  "I couldn’t get `codex models` from the CLI because the sandbox blocks the namespace setup it needs",
  "I can only see the current session model from this environment",
  "Available in this session:",
  "Available models in this session:",
  "Available models in this environment:",
  "Available models in this Codex environment:",
  "Available agent models:",
  "Visible options in this session:",
  "Current: `codex/",
  "Current model:",
  "Current model: `codex/",
  "Current model is `codex/",
  "Current session model: `codex/",
  "Current session model is `codex/",
  "The current session is using `codex/",
  "Configured model from `~/.codex/config.toml`:",
  "Configured models in this session:",
  "Default model:",
  "This harness is configured with a single Codex model: `codex/",
  "Primary model: `codex/",
  "Registered models: `codex/",
  "Current active model is `codex/",
  "Current OpenClaw session status reports the active model as:",
] as const;

export function isExpectedCodexModelsCommandText(text: string): boolean {
  const normalized = text.toLowerCase();
  const isSandboxFallback =
    text.includes("`codex models`") &&
    (text.includes("did not run") ||
      text.includes("could not run") ||
      text.includes("could not be run") ||
      text.includes("failed in this sandbox") ||
      text.includes("failed with:") ||
      text.includes("repo-local fallback") ||
      text.includes("sandbox blocks") ||
      text.includes("interactive in this environment") ||
      text.includes("sandboxed session") ||
      text.includes("required user namespace"));

  const mentionsConfiguredModels =
    normalized.includes("configured model") ||
    normalized.includes("configured codex model") ||
    normalized.includes("configured models");
  const mentionsSessionModel =
    normalized.includes("current session is using") ||
    normalized.includes("current session model") ||
    normalized.includes("the current session is using");
  const mentionsConfigSummary =
    normalized.includes("default model") ||
    normalized.includes("primary model") ||
    normalized.includes("registered models") ||
    normalized.includes("only listed model") ||
    normalized.includes("single codex model") ||
    normalized.includes("live openclaw config shows") ||
    normalized.includes("current gateway config");
  const isSessionConfigFallback =
    text.includes("`codex/") &&
    ((mentionsConfiguredModels && mentionsSessionModel) ||
      (mentionsConfigSummary && (mentionsConfiguredModels || mentionsSessionModel)));

  const mentionsInteractiveSelection =
    normalized.includes("interactive model-selection prompt") ||
    normalized.includes("interactive model selection prompt");
  const mentionsVisibleOptions =
    normalized.includes("visible options in this session:") ||
    normalized.includes("visible options:");
  const mentionsCurrentActiveModel =
    normalized.includes("current active model is `codex/") ||
    normalized.includes("current active model is codex/");
  const isInteractiveSelectionSummary =
    text.includes("`/codex models`") &&
    mentionsInteractiveSelection &&
    mentionsVisibleOptions &&
    mentionsCurrentActiveModel;

  return isSandboxFallback || isSessionConfigFallback || isInteractiveSelectionSummary;
}
