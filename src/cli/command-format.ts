// Formats CLI command examples with active container/profile hints when they apply.
import { normalizeProfileName } from "./profile-utils.js";

const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const CONTAINER_FLAG_RE = /(?:^|\s)--container(?:\s|=|$)/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
const UPDATE_RE = /^(?:\s+--(?:dev|no-color|(?:profile|log-level)[=\s]+\S+))*\s+update(?:\s|$)/;
const CONTAINER_HINT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Add active root options to a displayed command without duplicating explicit flags. */
export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const rawContainer = env.OPENCLAW_CONTAINER_HINT?.trim();
  const container = rawContainer && CONTAINER_HINT_RE.test(rawContainer) ? rawContainer : undefined;
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!container && !profile) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  const additions: string[] = [];
  if (
    container &&
    !CONTAINER_FLAG_RE.test(command) &&
    !UPDATE_RE.test(command.replace(CLI_PREFIX_RE, ""))
  ) {
    additions.push(`--container ${container}`);
  }
  if (!container && profile && !PROFILE_FLAG_RE.test(command) && !DEV_FLAG_RE.test(command)) {
    additions.push(`--profile ${profile}`);
  }
  if (additions.length === 0) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (match) => `${match} ${additions.join(" ")}`);
}
