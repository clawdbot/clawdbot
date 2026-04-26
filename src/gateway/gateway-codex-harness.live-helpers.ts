export const EXPECTED_CODEX_MODELS_COMMAND_TEXT = [
  "Codex models:",
  "Available Codex models",
  "Available models:",
  "Available models, local cache:",
  "Available agent target:",
  "Available agent targets:",
  "Available agent IDs in this session:",
  "opened an interactive trust prompt",
  "opened an interactive model-selection prompt",
  "running as Codex on `openai/",
  "running as Codex on `codex/",
  "currently running on `openai/",
  "currently running on `codex/",
  "stdin is not a terminal",
  "The local `codex models` entrypoint is interactive in this environment",
  "`codex models` did not run in this environment.",
  "`codex models` failed in this sandbox",
  "`codex models` could not be run in this sandbox.",
  "`codex models` is not runnable in this sandboxed session.",
  "`codex` is not installed on the shell PATH in this environment.",
  "`codex` is not installed in the shell environment",
  "`codex models` didn’t return a plain list in this environment",
  "I couldn’t get a direct `codex models` CLI listing because the local sandbox blocked that command.",
  "I couldn’t list all installed/available Codex models from the local CLI because the sandboxed `codex` command failed to start in this environment.",
  "I couldn’t get `codex models` from the CLI because the sandbox blocks the namespace setup it needs",
  "I can only see the current session model from this environment",
  "Available in this session:",
  "Available here:",
  "Available models in this session:",
  "Available models in this environment:",
  "Available models in this Codex environment:",
  "Available models in this Codex install",
  "Available model overrides:",
  "Available model overrides exposed in this session",
  "Available model overrides here:",
  "Available model overrides listed in this session:",
  "Available model overrides shown in this session:",
  "Available model overrides in this session:",
  "Available agent models:",
  "Visible options in this session:",
  "Current: `openai/",
  "Current: `codex/",
  "Current model:",
  "Current model: `openai/",
  "Current model: `codex/",
  "Current model is `openai/",
  "Current model is `codex/",
  "Current session model: `openai/",
  "Current session model: `codex/",
  "Current session model is `openai/",
  "Current session model is `codex/",
  "Visible session model:",
  "The current session is using `openai/",
  "The current session is using `codex/",
  "current session is using `openai/",
  "current session is using `codex/",
  "Configured model from `~/.codex/config.toml`:",
  "Configured models in this session:",
  "Default model:",
  "This harness is configured with a single Codex model: `openai/",
  "This harness is configured with a single Codex model: `codex/",
  "Primary model: `openai/",
  "Primary model: `codex/",
  "Registered models: `openai/",
  "Registered models: `codex/",
  "Active model: `openai/",
  "Active model: `codex/",
  "Current active model is `openai/",
  "Current active model is `codex/",
  "Current OpenClaw session status reports the active model as:",
] as const;

export function isExpectedCodexModelsCommandText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsCodexModelsCommand =
    text.includes("`codex models`") || text.includes("`/codex models`");
  const isSandboxFallback =
    mentionsCodexModelsCommand &&
    (normalized.includes("did not run") ||
      normalized.includes("could not run") ||
      normalized.includes("could not be run") ||
      normalized.includes("failed in this sandbox") ||
      normalized.includes("failed with:") ||
      normalized.includes("fails to start") ||
      normalized.includes("repo-local fallback") ||
      normalized.includes("sandbox blocks") ||
      ((normalized.includes("rejected") || normalized.includes("not approved")) &&
        (normalized.includes("sandbox") ||
          normalized.includes("permission") ||
          normalized.includes("permissions") ||
          normalized.includes("escalation") ||
          normalized.includes("elevated execution"))) ||
      normalized.includes("interactive in this environment") ||
      normalized.includes("dropped into the interactive ui") ||
      normalized.includes("does not provide a separate non-interactive") ||
      (normalized.includes("not installed") &&
        normalized.includes("path") &&
        (normalized.includes("codex cli") || normalized.includes("`codex`"))) ||
      normalized.includes("not installed on the shell path") ||
      normalized.includes("sandboxed session") ||
      normalized.includes("command not found") ||
      normalized.includes("not installed") ||
      normalized.includes("required user namespace") ||
      normalized.includes("user-namespace restriction") ||
      normalized.includes("bwrap: no permissions to create a new namespace"));

  const mentionsConfiguredModels =
    normalized.includes("configured model") ||
    normalized.includes("configured codex model") ||
    normalized.includes("configured models");
  const mentionsSessionModel =
    normalized.includes("current session is using") ||
    normalized.includes("current session model") ||
    normalized.includes("visible session model") ||
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
    (text.includes("`openai/") || text.includes("`codex/")) &&
    ((mentionsConfiguredModels && mentionsSessionModel) ||
      (mentionsConfigSummary && (mentionsConfiguredModels || mentionsSessionModel)));

  const mentionsInteractiveSelection =
    normalized.includes("interactive model-selection prompt") ||
    normalized.includes("interactive model selection prompt") ||
    normalized.includes("interactive tui");
  const mentionsVisibleOptions =
    normalized.includes("visible options in this session:") ||
    normalized.includes("visible options:") ||
    normalized.includes("available model overrides listed in this session:") ||
    normalized.includes("available model overrides shown in this session:") ||
    normalized.includes("available here:") ||
    normalized.includes("available agent ids in this session:");
  const mentionsCurrentActiveModel =
    normalized.includes("current active model is `openai/") ||
    normalized.includes("current active model is openai/") ||
    normalized.includes("current active model is `codex/") ||
    normalized.includes("current active model is codex/");
  const mentionsCurrentSelectedModel =
    normalized.includes("current selected model:") ||
    normalized.includes("currently selected model:");
  const isInteractiveSelectionSummary =
    text.includes("`/codex models`") &&
    mentionsInteractiveSelection &&
    mentionsVisibleOptions &&
    mentionsCurrentActiveModel;
  const isAgentIdModelSummary =
    normalized.includes("available agent ids in this session:") &&
    (text.includes("`openai/") || text.includes("`codex/"));
  const isAvailableHereModelSummary =
    normalized.includes("available here:") &&
    normalized.includes("current session model") &&
    (text.includes("`openai/") || text.includes("`codex/"));
  const isInteractiveTuiSummary =
    mentionsCodexModelsCommand &&
    mentionsInteractiveSelection &&
    normalized.includes("plain list") &&
    mentionsCurrentSelectedModel;

  return (
    isSandboxFallback ||
    isSessionConfigFallback ||
    isInteractiveSelectionSummary ||
    isAgentIdModelSummary ||
    isAvailableHereModelSummary ||
    isInteractiveTuiSummary
  );
}
