// Shared OpenClaw banner: the pixel lobster mascot beside the OPENCLAW
// wordmark, with a short startup animation on rich interactive terminals.
// Used by the wizard flows (doctor/onboard/configure) and the foreground
// gateway run; non-TTY and CI paths always get the plain static banner.
import {
  decorativeEmoji,
  supportsDecorativeEmoji,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../runtime.js";

// Art is pregenerated from pixel bitmaps (two pixel rows per terminal row via
// ▀▄█). Mascot and wordmark are separate so they can be tinted independently;
// the wordmark starts on mascot row 2, keeping the claws above the text line.
const MASCOT_ART = [
  "▄███▄     ▄███▄",
  "▀█▄█▀     ▀█▄█▀",
  "     ▀▄ ▄▀",
  "    ██ █ ██",
  "    ▀█████▀",
  "   ▄█▀ █ ▀█▄",
] as const;
// Claw tips with the pincer notch widened; swapping the top two rows in and
// out produces the "snip".
const MASCOT_OPEN_ROWS = ["▄█▀█▄     ▄█▀█▄", "▀█ █▀     ▀█ █▀"] as const;
const MASCOT_WIDTH = 15;
const WORDMARK_ROW_OFFSET = 2;

const WORDMARK_ART = [
  "█▀▀▀█ █▀▀▀█ █▀▀▀▀ █▄  █ █▀▀▀▀ █     █▀▀▀█ █   █",
  "█   █ █▀▀▀▀ █▀▀▀  █ ▀▄█ █     █     █▀▀▀█ █▄▀▄█",
  "▀▀▀▀▀ ▀     ▀▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀   ▀ ▀   ▀",
] as const;
const GAP = 3;
const BANNER_WIDTH = MASCOT_WIDTH + GAP + 48;
const ROWS = MASCOT_ART.length;

type ClawBannerOptions = {
  columns?: number;
  isTty?: boolean;
  rich?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injectable randomness for the animation garnish (tests pin it). */
  rng?: () => number;
  /** Ends the animation on its static frame when parallel startup work settles. */
  settleWhen?: PromiseLike<unknown>;
  sleep?: (ms: number) => Promise<void>;
  write?: (chunk: string) => void;
};

export type ClawBannerResult = "static" | "completed" | "settled";

type CellTint = (col: number) => (text: string) => string;

const identityTint: (text: string) => string = (text) => text;

// Composes one banner frame. Tints run per glyph column so the wipe edge and
// shimmer band can cut through individual letters.
function composeFrame(params: {
  mascotRows?: readonly string[];
  mascotTint?: CellTint;
  wordmarkTint?: CellTint;
}): string[] {
  const mascotRows = params.mascotRows ?? MASCOT_ART;
  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    const mascotRow = (mascotRows[row] ?? "").padEnd(MASCOT_WIDTH).slice(0, MASCOT_WIDTH);
    let out = "";
    for (let col = 0; col < mascotRow.length; col++) {
      const ch = mascotRow[col] ?? " ";
      out += ch === " " ? " " : (params.mascotTint?.(col) ?? theme.accent)(ch);
    }
    const wordmarkRow = WORDMARK_ART[row - WORDMARK_ROW_OFFSET];
    if (wordmarkRow) {
      out += " ".repeat(GAP);
      for (let col = 0; col < wordmarkRow.length; col++) {
        const ch = wordmarkRow[col] ?? " ";
        out +=
          ch === " " ? " " : (params.wordmarkTint?.(MASCOT_WIDTH + GAP + col) ?? identityTint)(ch);
      }
    }
    lines.push(out.replace(/\s+$/, ""));
  }
  return lines;
}

function staticBannerLines(): string[] {
  return composeFrame({});
}

function plainTitleLine(): string {
  const icon = decorativeEmoji("🦞");
  return supportsDecorativeEmoji() && icon ? `${icon} OPENCLAW ${icon}` : "OPENCLAW";
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// One combined entrance: a left-to-right molt wipe reveals the color, a
// shimmer band sweeps the wordmark, and the claws snip. The rng varies the
// shimmer passes and snip count a little so back-to-back runs don't feel
// canned; every sequence ends on the exact static banner.
async function animateBanner(opts: {
  rng: () => number;
  settleWhen?: PromiseLike<unknown>;
  sleep: (ms: number) => Promise<void>;
  write: (chunk: string) => void;
}): Promise<Exclude<ClawBannerResult, "static">> {
  const { rng, settleWhen, sleep, write } = opts;
  let settleRequested = false;
  const settleSignal = settleWhen
    ? Promise.resolve(settleWhen).then(
        () => {
          settleRequested = true;
        },
        () => {
          settleRequested = true;
        },
      )
    : null;
  const pause = async (ms: number): Promise<boolean> => {
    if (!settleSignal) {
      await sleep(ms);
      return true;
    }
    await Promise.race([sleep(ms), settleSignal]);
    return !settleRequested;
  };
  let drewFrame = false;
  const draw = (lines: string[]) => {
    const prefix = drewFrame ? `\x1b[${ROWS}F` : "";
    drewFrame = true;
    write(`${prefix}${lines.map((line) => `\x1b[K${line}`).join("\n")}\n`);
  };
  // Ctrl-C during the ~1s sequence would otherwise kill the process with the
  // cursor still hidden: default signal death skips the finally block. The
  // banner runs before any other component installs signal handlers, so a
  // scoped restore-and-exit handler is safe here and removed right after.
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    restoreTerminalState(`claw banner ${signal}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  write("\x1b[?25l");
  try {
    // Molt wipe: dim shell ahead of a bright 2-column edge, color behind it.
    const wipeSteps = 9;
    for (let step = 0; step <= wipeSteps; step++) {
      const edge = Math.round((BANNER_WIDTH * step) / wipeSteps);
      const tintAt =
        (colored: (text: string) => string): CellTint =>
        (col) =>
          col < edge ? colored : col < edge + 2 ? theme.accentBright : theme.muted;
      draw(
        composeFrame({
          mascotTint: tintAt(theme.accent),
          wordmarkTint: tintAt(identityTint),
        }),
      );
      if (!(await pause(45))) {
        return "settled";
      }
    }
    // Shimmer: a bright band sweeps the wordmark; rarely it runs twice.
    const shimmerPasses = rng() < 0.2 ? 2 : 1;
    for (let pass = 0; pass < shimmerPasses; pass++) {
      for (let x = MASCOT_WIDTH; x < BANNER_WIDTH + 6; x += 4) {
        const band: CellTint = (col) =>
          col >= x && col < x + 6 ? theme.accentBright : identityTint;
        draw(composeFrame({ wordmarkTint: band }));
        if (!(await pause(40))) {
          return "settled";
        }
      }
    }
    // Snip: claws open and close once, sometimes twice.
    const snips = rng() < 0.4 ? 2 : 1;
    for (let snip = 0; snip < snips; snip++) {
      draw(composeFrame({ mascotRows: [...MASCOT_OPEN_ROWS, ...MASCOT_ART.slice(2)] }));
      if (!(await pause(95))) {
        return "settled";
      }
      draw(staticBannerLines());
      if (!(await pause(115))) {
        return "settled";
      }
    }
    draw(staticBannerLines());
    return "completed";
  } finally {
    try {
      // Parallel work owns startup latency; leave a complete banner instead of
      // an interrupted frame before its logs or errors take over the terminal.
      if (settleRequested && drewFrame) {
        draw(staticBannerLines());
      }
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      write("\x1b[?25h");
    }
  }
}

/**
 * Prints the OpenClaw banner: animated on rich interactive terminals, static
 * otherwise, plain title on terminals too narrow for the art.
 */
export async function printClawBanner(
  runtime: RuntimeEnv,
  options: ClawBannerOptions = {},
): Promise<ClawBannerResult> {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  if (columns < BANNER_WIDTH) {
    runtime.log(`${plainTitleLine()}\n`);
    return "static";
  }
  const env = options.env ?? process.env;
  const animate =
    (options.isTty ?? process.stdout.isTTY ?? false) &&
    (options.rich ?? isRich()) &&
    !env.CI &&
    !env.VITEST;
  if (!animate) {
    runtime.log(`${staticBannerLines().join("\n")}\n`);
    return "static";
  }
  const result = await animateBanner({
    rng: options.rng ?? Math.random,
    settleWhen: options.settleWhen,
    sleep: options.sleep ?? defaultSleep,
    write: options.write ?? ((chunk) => process.stdout.write(chunk)),
  });
  (options.write ?? ((chunk: string) => process.stdout.write(chunk)))("\n");
  return result;
}
