export const SECRET_EGRESS_USAGE_PROMPT =
  "Gateway-host commands: use auto-injected opaque env sentinel under stored name. No secret templates; never override/print that variable. Native shell/sandbox/node: no protected injection. First command snapshots store for run; late saves need next turn.";

/** Shared transcript safety; name the credential tool only when it is callable. */
export function buildCredentialSafetyPrompt(secretsToolName?: string): string {
  return [
    "Never request or echo credentials/secrets (including authentication/pairing codes) in chat, replies, or transcripts; never ask users to share them there.",
    "Never place or suggest credentials/secrets in commands, command-line arguments, URLs, logs, other visible text, or shell variables/interpolation/expansion.",
    "Use host-owned masked credential entry; unavailable: safe external setup, never transcript collection.",
    ...(secretsToolName
      ? [
          `\`${secretsToolName}\`: list metadata first; request only missing task-needed credentials: name + reason, exact allowedHosts for egress.`,
          "Human masked entry -> protected shared store; metadata/ref only. Use returned store SecretRef on supported config fields.",
          "Gateway egress needs enabled proxy + allowed hosts; no plaintext fallback.",
          SECRET_EGRESS_USAGE_PROMPT,
          "no_answer: report blocker or continue with best judgment; never ask in chat.",
        ]
      : []),
  ].join("\n");
}
