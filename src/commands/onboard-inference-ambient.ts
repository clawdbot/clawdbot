export const OPENAI_API_DEFAULT_MODEL_REF = "openai/gpt-5.6";
export const ANTHROPIC_API_DEFAULT_MODEL_REF = "anthropic/claude-opus-4-8";
export const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-4-8";
export const CODEX_APP_SERVER_DEFAULT_MODEL_REF = "openai/gpt-5.6-sol";
export const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3.1-pro-preview";

export type InferenceBackendKind =
  | "existing-model"
  | "openai-api-key"
  | "anthropic-api-key"
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli";

export type InferenceBackendCandidate = {
  kind: InferenceBackendKind;
  modelRef: string;
  /** Short human label, e.g. "Claude Code CLI". */
  label: string;
  /** One-line provenance, e.g. "logged in", "ANTHROPIC_API_KEY set". */
  detail: string;
  /**
   * true: credentials verified; false: definitively logged out; undefined:
   * unknown (e.g. macOS keychain-backed logins we must not prompt for here).
   */
  credentials?: boolean;
};

export function detectAmbientInferenceBackends(
  env: NodeJS.ProcessEnv = process.env,
): InferenceBackendCandidate[] {
  const candidates: InferenceBackendCandidate[] = [];
  if (env.OPENAI_API_KEY?.trim()) {
    candidates.push({
      kind: "openai-api-key",
      modelRef: OPENAI_API_DEFAULT_MODEL_REF,
      label: "OpenAI API key",
      detail: "OPENAI_API_KEY set",
      credentials: true,
    });
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    candidates.push({
      kind: "anthropic-api-key",
      modelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
      label: "Anthropic API key",
      detail: "ANTHROPIC_API_KEY set",
      credentials: true,
    });
  }
  return candidates;
}
