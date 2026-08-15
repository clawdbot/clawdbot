// Android node capability required-command helper.

export const ANDROID_NODE_REQUIRED_NON_INTERACTIVE_COMMANDS = [
  "device.health",
  "device.info",
  "device.permissions",
  "device.status",
] as const;

export function findMissingRequiredAndroidNodeCommands(params: {
  commandsToRun: readonly string[];
  requiredCommands: readonly string[];
}): string[] {
  const runnable = new Set(params.commandsToRun);
  return params.requiredCommands
    .filter((command) => !runnable.has(command))
    .toSorted((left, right) => left.localeCompare(right));
}
