import { Type } from "typebox";
import type { TSchema } from "typebox";
import { stringEnum as createStringEnum } from "../agents/schema/typebox.js";

export {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  parseAvailableTags,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  ToolAuthorizationError,
} from "../agents/tools/common.js";
export type { ActionGate } from "../agents/tools/common.js";
export { withNormalizedTimestamp } from "../agents/date-time.js";
export { assertMediaNotDataUrl } from "../agents/sandbox-paths.js";
export { resolvePollMaxSelections } from "../polls.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";

/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native button schemas through the shared message tool.
 */
export function createMessageToolButtonsSchema(): TSchema {
  return Type.Optional(
    Type.Array(
      Type.Array(
        Type.Object({
          text: Type.String(),
          callback_data: Type.String(),
          style: Type.Optional(createStringEnum(["danger", "success", "primary"])),
        }),
      ),
      {
        description: "Button rows for channels that support button-style actions.",
      },
    ),
  );
}

/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native card schemas through the shared message tool.
 */
export function createMessageToolCardSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Structured card payload for channels that support card-style messages.",
      },
    ),
  );
}
