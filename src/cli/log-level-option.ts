// Commander parser for the shared CLI --log-level option.
import { InvalidArgumentError } from "commander";
import { ALLOWED_LOG_LEVELS, type LogLevel, tryParseLogLevel } from "../logging/levels.js";

export const CLI_LOG_LEVEL_VALUES = ALLOWED_LOG_LEVELS.join("|");

export function parseCliLogLevelOption(value: string): LogLevel {
  const parsed = tryParseLogLevel(value);
  if (!parsed) {
    throw new InvalidArgumentError(`Invalid --log-level (use ${CLI_LOG_LEVEL_VALUES})`);
  }
  return parsed;
}
