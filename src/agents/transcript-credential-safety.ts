import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Never solicit a credential. This rule prevents exposure that would not
 * otherwise exist, and it protects every participant rather than only the
 * operator, so no configuration removes it.
 */
const NEVER_SOLICIT_CREDENTIALS =
  "Credentials and secrets include authentication and pairing codes; never ask or request users to report, share, or provide them in chat, conversation messages, replies, or transcripts.";

/**
 * Handling rules for a credential the operator chose to supply. These govern
 * what happens to a value that is already in the transcript, so an operator who
 * accepts that exposure can opt out of them.
 */
const CREDENTIAL_HANDLING_RULES = [
  "Never echo or repeat credentials or secrets in chat, conversation messages, replies, or any other transcript.",
  "Never place, put, or include credentials or secrets—or recommend or suggest doing so—in commands, command-line arguments, URLs, logs, or other visible text, including shell variables or interpolation.",
  "Use only a dedicated host-owned masked or secure structured credential-entry setup. If no such setup is available, direct the user to a safe external setup instead of collecting the credential in the transcript.",
].join("\n");

export const TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT = [
  NEVER_SOLICIT_CREDENTIALS,
  CREDENTIAL_HANDLING_RULES,
].join("\n");

/**
 * Credential-safety contract for harness prompts. Always returns text: the
 * no-solicitation rule survives every configuration.
 *
 * `security.allowCredentialsInTranscript` drops only the handling rules, which
 * apply to a credential the operator has already put in the transcript. Opting
 * out suits deployments that accept that value reaching logs and every
 * transcript-derived store (memory index, promoted memory, prompt cache); it
 * never lets the agent request a credential from anyone. The system agent
 * ignores the flag entirely — it owns the guided setup surfaces that give
 * credentials a masked entry path.
 */
export function transcriptCredentialSafetyPrompt(cfg?: OpenClawConfig): string {
  return cfg?.security?.allowCredentialsInTranscript === true
    ? NEVER_SOLICIT_CREDENTIALS
    : TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT;
}
