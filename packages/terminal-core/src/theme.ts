// Terminal Core module implements theme behavior.
import chalk, { Chalk } from "chalk";
import { CRAB_PALETTE } from "./palette.js";

// Shared terminal color theme that respects NO_COLOR and FORCE_COLOR.

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

/** Shared terminal theme color functions. */
export const theme = {
  accent: hex(CRAB_PALETTE.accent),
  accentBright: hex(CRAB_PALETTE.accentBright),
  accentDim: hex(CRAB_PALETTE.accentDim),
  info: hex(CRAB_PALETTE.info),
  success: hex(CRAB_PALETTE.success),
  warn: hex(CRAB_PALETTE.warn),
  error: hex(CRAB_PALETTE.error),
  muted: hex(CRAB_PALETTE.muted),
  heading: baseChalk.bold.hex(CRAB_PALETTE.accent),
  command: hex(CRAB_PALETTE.accentBright),
  option: hex(CRAB_PALETTE.warn),
} as const;

/** Return true when color styling is active. */
export const isRich = () => baseChalk.level > 0;

/** Conditionally apply a color function based on caller rich-output state. */
export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
