import { normalizeProfileName } from "./profile-utils.js";
import { replaceCliName, resolveCliName } from "./cli-name.js";

const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+(?:moltbot|moltbot)\b|^(?:moltbot|moltbot)\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const cliName = resolveCliName(undefined, env);
  const normalizedCommand = replaceCliName(command, cliName);
  const profile = normalizeProfileName(env.CLAWDBOT_PROFILE);
  if (!profile) return normalizedCommand;
  if (!CLI_PREFIX_RE.test(normalizedCommand)) return normalizedCommand;
  if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}
