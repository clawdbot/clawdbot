import { resolveCommitHash } from "../infra/git-commit.js";
import { isRich, theme } from "../terminal/theme.js";
import { pickTagline, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  richTty?: boolean;
};

let bannerEmitted = false;

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V" || arg === "-v");

export function formatCliBannerLine(
  version: string,
  options: BannerOptions = {},
): string {
  const commit = options.commit ?? resolveCommitHash({ env: options.env });
  const commitLabel = commit ?? "unknown";
  const tagline = pickTagline(options);
  const rich = options.richTty ?? isRich();
  const title = "🦞 ClawdBot";
  if (rich) {
    return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
  }
  return `${title} ${version} (${commitLabel}) — ${tagline}`;
}

export function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) return;
  const argv = options.argv ?? process.argv;
  if (!process.stdout.isTTY) return;
  if (hasJsonFlag(argv)) return;
  if (hasVersionFlag(argv)) return;
  const line = formatCliBannerLine(version, options);
  process.stdout.write(`\n${line}\n\n`);
  bannerEmitted = true;
}
