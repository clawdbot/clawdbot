// Logging shared types describe logger configuration and output options.
import type { LogLevel } from "./levels.js";

// Shared logger settings contracts for file and console transports.
export type ConsoleStyle = "pretty" | "compact" | "json";

/** User-configurable logger settings after config/env normalization. */
export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
};
