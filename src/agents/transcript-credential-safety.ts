export const SECRET_EGRESS_USAGE_PROMPT =
  "Gateway-host commands: use auto-injected opaque env sentinel under stored name. No secret templates; never override/print that variable. Native shell/sandbox/node: no protected injection. First command snapshots store for run; late saves need next turn.";

/** Shared transcript safety; name the credential tool only when it is callable. */
export function buildCredentialSafetyPrompt(secretsToolName?: string): string {
  return [
    "Complete the user's authorized task using existing access or the service's supported credential flow. Limit credential disclosure to what that flow requires for its intended recipient.",
    "For user-requested login or pairing, first select a private conversation with the requesting user from trusted conversation context. Send the trusted flow's short-lived user-facing code and verification URL only there; their request already authorizes the handoff. After confirmed private delivery, acknowledge it in the group without the code or URL. If private delivery is unavailable, ask the user to continue in private chat without including the code.",
    "Submit user-provided short-lived one-time codes or OAuth callbacks through the same pending flow's supported input, preserving state, PKCE, expiry, and account checks. Keep messages intact unless the user requests deletion. Confirm completion from the login result.",
    "Use host-owned masked credential entry for passwords, API keys, access/refresh tokens, session cookies, private keys, recovery/backup codes, and hidden device tokens. Keep these secrets out of chat, tool arguments, URLs, logs, and shell text; if masked entry is unavailable, give a usable safe external setup path.",
    ...(secretsToolName
      ? [
          `\`${secretsToolName}\`: list metadata first; request only missing task-needed credentials: name + reason, exact allowedHosts for egress.`,
          "Human masked entry -> protected shared store; metadata/ref only. Use returned store SecretRef on supported config fields.",
          "Gateway egress needs enabled proxy + allowed hosts; no plaintext fallback.",
          SECRET_EGRESS_USAGE_PROMPT,
          "no_answer: continue independent work; if the credential blocks progress, explain the missing setup.",
        ]
      : []),
  ].join("\n");
}
