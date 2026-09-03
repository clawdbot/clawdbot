import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { paneDomId } from "./chat-composer-dom.ts";

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

export function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}
