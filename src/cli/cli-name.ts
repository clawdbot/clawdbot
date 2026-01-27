import path from "node:path";

export const DEFAULT_CLI_NAME = "moltbot";
export const LEGACY_CLI_NAME = "moltbot";

const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME, LEGACY_CLI_NAME]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(moltbot|moltbot)\b/;

export function resolveCliName(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const override = env.MOLTBOT_CLI_NAME?.trim() || env.CLAWDBOT_CLI_NAME?.trim();
  if (override) return override;
  const argv1 = argv[1];
  if (!argv1) return DEFAULT_CLI_NAME;
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) return base;
  return DEFAULT_CLI_NAME;
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) return command;
  if (!CLI_PREFIX_RE.test(command)) return command;
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
