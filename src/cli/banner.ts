import { resolveCommitHash } from "../infra/git-commit.js";
import { isRich, theme } from "../terminal/theme.js";
import { pickTagline, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  richTty?: boolean;
};

let bannerEmitted = false;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitGraphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  try {
    return Array.from(graphemeSegmenter.segment(value), (seg) => seg.segment);
  } catch {
    return Array.from(value);
  }
}

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
  const title = "🦞 Clawdbot";
  if (rich) {
    return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
  }
  return `${title} ${version} (${commitLabel}) — ${tagline}`;
}

const LOBSTER_ASCII = [
  "░████░█░░░░░█████░█░░░█░███░░████░░████░░▀█▀",
  "█░░░░░█░░░░░█░░░█░█░█░█░█░░█░█░░░█░█░░░█░░█░",
  "█░░░░░█░░░░░█████░█░█░█░█░░█░████░░█░░░█░░█░",
  "█░░░░░█░░░░░█░░░█░█░█░█░█░░█░█░░█░░█░░░█░░█░",
  "░████░█████░█░░░█░░█░█░░███░░████░░░███░░░█░",
  "              🦞 FRESH DAILY 🦞",
];

export function formatCliBannerArt(options: BannerOptions = {}): string {
  const rich = options.richTty ?? isRich();
  if (!rich) return LOBSTER_ASCII.join("\n");

  const colorChar = (ch: string) => {
    if (ch === "█") return theme.accentBright(ch);
    if (ch === "░") return theme.accentDim(ch);
    if (ch === "▀") return theme.accent(ch);
    return theme.muted(ch);
  };

  const colored = LOBSTER_ASCII.map((line) => {
    if (line.includes("FRESH DAILY")) {
      return (
        theme.muted("              ") +
        theme.accent("🦞") +
        theme.info(" FRESH DAILY ") +
        theme.accent("🦞")
      );
    }
    return splitGraphemes(line).map(colorChar).join("");
  });

  return colored.join("\n");
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

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
