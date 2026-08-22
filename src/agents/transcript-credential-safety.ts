import type { OpenClawConfig } from "../config/types.openclaw.js";

export const TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT = [
  "Credentials and secrets include authentication and pairing codes; never ask or request users to report, share, or provide them in chat, conversation messages, replies, or transcripts.",
  "Never echo or repeat credentials or secrets in chat, conversation messages, replies, or any other transcript.",
  "Never place, put, or include credentials or secrets—or recommend or suggest doing so—in commands, command-line arguments, URLs, logs, or other visible text, including shell variables or interpolation.",
  "Use only a dedicated host-owned masked or secure structured credential-entry setup. If no such setup is available, direct the user to a safe external setup instead of collecting the credential in the transcript.",
].join("\n");

/**
 * Credential-safety contract section, or undefined when the operator opted out
 * via `security.allowCredentialsInTranscript`. Harnesses drop undefined
 * sections, so this is the only accessor they need — none of them gates the
 * contract text itself.
 *
 * Opting out only fits deployments that accept credentials reaching
 * transcripts, logs, and every transcript-derived store (memory index, promoted
 * memory, prompt cache). The system agent ignores the flag: it owns the guided
 * setup surfaces that already give credentials a masked entry path.
 */
export function transcriptCredentialSafetyPrompt(cfg?: OpenClawConfig): string | undefined {
  return cfg?.security?.allowCredentialsInTranscript === true
    ? undefined
    : TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT;
}
