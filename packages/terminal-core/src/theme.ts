// Terminal Core module implements theme behavior.
import chalk, { Chalk } from "chalk";
import { LOBSTER_PALETTE } from "./palette.js";

// Shared terminal color theme that respects NO_COLOR and FORCE_COLOR.

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

/** Shared terminal theme color functions. */
export const theme = {
  accent: hex(LOBSTER_PALETTE.accent),
  accentBright: hex(LOBSTER_PALETTE.accentBright),
  accentDim: hex(LOBSTER_PALETTE.accentDim),
  info: hex(LOBSTER_PALETTE.info),
  success: hex(LOBSTER_PALETTE.success),
  warn: hex(LOBSTER_PALETTE.warn),
  error: hex(LOBSTER_PALETTE.error),
  muted: hex(LOBSTER_PALETTE.muted),
  heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
  command: hex(LOBSTER_PALETTE.accentBright),
  option: hex(LOBSTER_PALETTE.warn),
} as const;

/** Return true when color styling is active. */
export const isRich = () => baseChalk.level > 0;

/** Conditionally apply a color function based on caller rich-output state. */
export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
