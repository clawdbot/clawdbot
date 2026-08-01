import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

type CommandTextContext = MsgContext & { BodyStripped?: string };

/** Keep every inbound-text projection aligned when command sugar becomes a normal agent turn. */
export function applyCommandTextToContext(ctx: MsgContext, text: string): void {
  const mutableCtx = ctx as CommandTextContext;
  mutableCtx.commandText = text;
  mutableCtx.agentText = text;
  mutableCtx.rawText = text;
  mutableCtx.Body = text;
  mutableCtx.RawBody = text;
  mutableCtx.CommandBody = text;
  mutableCtx.BodyForCommands = text;
  mutableCtx.BodyForAgent = text;
  mutableCtx.BodyStripped = text;
}

export function applyCommandTextToParams(params: HandleCommandsParams, text: string): void {
  applyCommandTextToContext(params.ctx, text);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyCommandTextToContext(params.rootCtx, text);
  }
  params.command.rawBodyNormalized = text;
  params.command.commandBodyNormalized = text;
}
