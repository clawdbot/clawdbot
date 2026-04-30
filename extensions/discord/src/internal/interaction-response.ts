import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";

export type InteractionResponseState =
  | "unacknowledged"
  | "deferred"
  | "deferred-update"
  | "replied";

export type InteractionReplyAction = "initial" | "edit" | "follow-up";

export class InteractionResponseController {
  state: InteractionResponseState = "unacknowledged";

  get acknowledged(): boolean {
    return this.state !== "unacknowledged";
  }

  recordCallback(type: InteractionResponseType): void {
    if (type === InteractionResponseType.DeferredChannelMessageWithSource) {
      this.state = "deferred";
      return;
    }
    if (type === InteractionResponseType.DeferredMessageUpdate) {
      this.state = "deferred-update";
      return;
    }
    this.state = "replied";
  }

  nextReplyAction(): InteractionReplyAction {
    if (this.state === "deferred" || this.state === "deferred-update") {
      return "edit";
    }
    if (this.state === "unacknowledged") {
      return "initial";
    }
    return "follow-up";
  }

  recordReplyEdit(): void {
    this.state = "replied";
  }
}

export function needsComponentsV2Query(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    "flags" in body &&
    typeof (body as { flags?: unknown }).flags === "number" &&
    ((body as { flags: number }).flags & MessageFlags.IsComponentsV2) !== 0
  );
}
