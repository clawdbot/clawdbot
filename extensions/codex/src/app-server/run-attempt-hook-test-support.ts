/** Reads the real native-hook relay identity encoded into a Codex thread request. */
export function extractRelayIdFromThreadRequest(params: unknown): string {
  const command = extractNativeHookRelayCommandFromThreadRequest(params);
  const match = command.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

export function extractGenerationFromThreadRequest(params: unknown): string {
  const command = extractNativeHookRelayCommandFromThreadRequest(params);
  const match = command.match(/--generation ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay generation missing from command: ${command}`);
  }
  return match[1];
}

function extractNativeHookRelayCommandFromThreadRequest(params: unknown): string {
  const config = (params as { config?: Record<string, unknown> }).config;
  for (const key of [
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
  ]) {
    const entries = config?.[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
      const command = entry.hooks?.find((hook) => typeof hook.command === "string")?.command;
      if (command) {
        return command;
      }
    }
  }
  throw new Error("native hook relay command missing from thread request");
}
