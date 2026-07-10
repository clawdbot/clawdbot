// CLI banner formatter and one-shot emitter.
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import {
  decorativeEmoji,
  decorativePrefix,
  stripDecorativeEmojiForTerminal,
  type DecorativeEmojiOptions,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { hasRootVersionAlias } from "./argv.js";
import { parseTaglineMode, readCliBannerTaglineMode } from "./banner-config-lite.js";
import { pickCliLobsterArt } from "./lobster-art.js";
import { pickTagline, type TaglineMode, type TaglineOptions } from "./tagline.js";

type BannerOptions = TaglineOptions & {
  argv?: string[];
  commit?: string | null;
  columns?: number;
  isTty?: boolean;
  platform?: NodeJS.Platform;
  richTty?: boolean;
};

let bannerEmitted = false;

const hasJsonFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V") || hasRootVersionAlias(argv);

function resolveTaglineMode(options: BannerOptions): TaglineMode | undefined {
  const explicit = parseTaglineMode(options.mode);
  if (explicit) {
    return explicit;
  }
  return readCliBannerTaglineMode(options.env);
}

function resolveEmojiOptions(options: BannerOptions): DecorativeEmojiOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
    ...(options.platform ? { platform: options.platform } : {}),
  };
}

/** Format the compact one-line CLI banner, wrapping tagline when terminal width requires it. */
export function formatCliBannerLine(version: string, options: BannerOptions = {}): string {
  const commit =
    options.commit ?? resolveCommitHash({ env: options.env, moduleUrl: import.meta.url });
  const commitLabel = commit ?? "unknown";
  const emojiOptions = resolveEmojiOptions(options);
  const tagline = stripDecorativeEmojiForTerminal(
    pickTagline({ ...options, mode: resolveTaglineMode(options) }),
    emojiOptions,
  );
  const rich = options.richTty ?? isRich();
  const title = decorativePrefix("🦞", "OpenClaw", emojiOptions);
  const prefix = decorativeEmoji("🦞", emojiOptions);
  const indent = prefix ? `${prefix} ` : "";
  const columns = options.columns ?? process.stdout.columns ?? 120;
  const plainBaseLine = `${title} ${version} (${commitLabel})`;
  const plainFullLine = tagline ? `${plainBaseLine} — ${tagline}` : plainBaseLine;
  const fitsOnOneLine = visibleWidth(plainFullLine) <= columns;
  if (rich) {
    if (fitsOnOneLine) {
      if (!tagline) {
        return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
      }
      return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
        `(${commitLabel})`,
      )} ${theme.muted("—")} ${theme.accentDim(tagline)}`;
    }
    const line1 = `${theme.heading(title)} ${theme.info(version)} ${theme.muted(
      `(${commitLabel})`,
    )}`;
    if (!tagline) {
      return line1;
    }
    const line2 = `${" ".repeat(indent.length)}${theme.accentDim(tagline)}`;
    return `${line1}\n${line2}`;
  }
  if (fitsOnOneLine) {
    return plainFullLine;
  }
  const line1 = plainBaseLine;
  if (!tagline) {
    return line1;
  }
  const line2 = `${" ".repeat(indent.length)}${tagline}`;
  return `${line1}\n${line2}`;
}

// Rare day-seeded ASCII lobster above the banner: random-tagline mode only,
// rich terminals only, never in CI (see lobster-art.ts for the odds).
function resolveLobsterArt(options: BannerOptions): string | null {
  const mode = resolveTaglineMode(options);
  if (mode === "off" || mode === "default") {
    return null;
  }
  if (!(options.richTty ?? isRich())) {
    return null;
  }
  const now = options.now ? options.now() : new Date();
  const art = pickCliLobsterArt(now, options.env ?? process.env);
  return art ? theme.accentDim(art) : null;
}

/** Emit the CLI banner once for interactive, non-JSON, non-version invocations. */
export function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  const isTty = options.isTty ?? process.stdout.isTTY;
  if (!isTty) {
    return;
  }
  if (hasJsonFlag(argv)) {
    return;
  }
  if (hasVersionFlag(argv)) {
    return;
  }
  const line = formatCliBannerLine(version, options);
  const art = resolveLobsterArt(options);
  process.stdout.write(`\n${art ? `${art}\n` : ""}${line}\n\n`);
  bannerEmitted = true;
}

/** Return whether the current process already emitted the CLI banner. */
export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}

export const testing = {
  resetBannerEmittedForTests(): void {
    bannerEmitted = false;
  },
};
