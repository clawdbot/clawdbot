/**
 * Slash command metadata registry.
 *
 * Defines built-in command metadata and the source shape used by prompts, skills, and extensions.
 */
import type { SourceInfo } from "./source-info.js";

type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo: SourceInfo;
}
