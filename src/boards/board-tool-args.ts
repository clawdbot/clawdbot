import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";

export const BOARD_WIDGET_NAME_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

/** Keeps an optional placement anchor representable when a model materializes every tool field. */
export function optionalBoardWidgetAnchorSchema(description: string) {
  return Type.Optional(
    Type.Union([Type.String({ pattern: BOARD_WIDGET_NAME_PATTERN }), Type.Null()], { description }),
  );
}

/** Converts the model-facing null sentinel back to the board contract's omitted anchor. */
export function omitNullBoardWidgetAnchor(args: unknown): unknown {
  if (!isRecord(args) || args.after !== null) {
    return args;
  }
  const { after: _after, ...rest } = args;
  return rest;
}
