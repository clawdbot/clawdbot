// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Command catalog protocol schemas.
 *
 * Command entries describe native, skill, and plugin commands that clients can
 * render or route; limits keep command catalogs bounded for UI and transport.
 */
/** Maximum command display/name length accepted in catalog entries. */
export const COMMAND_NAME_MAX_LENGTH = 200;
/** Maximum command description length accepted in catalog entries. */
export const COMMAND_DESCRIPTION_MAX_LENGTH = 2_000;
/** Maximum text aliases advertised for one command. */
export const COMMAND_ALIAS_MAX_ITEMS = 20;
/** Maximum declared arguments advertised for one command. */
export const COMMAND_ARGS_MAX_ITEMS = 20;
/** Maximum argument name length accepted in catalog entries. */
export const COMMAND_ARG_NAME_MAX_LENGTH = 200;
/** Maximum argument description length accepted in catalog entries. */
export const COMMAND_ARG_DESCRIPTION_MAX_LENGTH = 500;
/** Maximum static choices advertised for one argument. */
export const COMMAND_ARG_CHOICES_MAX_ITEMS = 50;
/** Maximum machine-readable choice value length. */
export const COMMAND_CHOICE_VALUE_MAX_LENGTH = 200;
/** Maximum user-facing choice label length. */
export const COMMAND_CHOICE_LABEL_MAX_LENGTH = 200;
/** Maximum commands returned by one catalog response. */
export const COMMAND_LIST_MAX_ITEMS = 500;

const BoundedNonEmptyString = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** Source system that contributed a command. */
export const CommandSourceSchema = Type.Union([
  Type.Literal("native"),
  Type.Literal("skill"),
  Type.Literal("plugin"),
]);

/** Surfaces where a command may be invoked. */
export const CommandScopeSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("native"),
  Type.Literal("both"),
]);

/** Coarse UI grouping for command catalog display. */
export const CommandCategorySchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("options"),
  Type.Literal("status"),
  Type.Literal("management"),
  Type.Literal("media"),
  Type.Literal("tools"),
  Type.Literal("docks"),
]);

/** Static argument choice shown to clients. */
export const CommandArgChoiceSchema = Type.Object(
  {
    value: Type.String({ maxLength: COMMAND_CHOICE_VALUE_MAX_LENGTH }),
    label: Type.String({ maxLength: COMMAND_CHOICE_LABEL_MAX_LENGTH }),
  },
  { additionalProperties: false },
);

/** One typed argument advertised for a command. */
export const CommandArgSchema = Type.Object(
  {
    name: BoundedNonEmptyString(COMMAND_ARG_NAME_MAX_LENGTH),
    description: Type.String({ maxLength: COMMAND_ARG_DESCRIPTION_MAX_LENGTH }),
    type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
    required: Type.Optional(Type.Boolean()),
    choices: Type.Optional(
      Type.Array(CommandArgChoiceSchema, { maxItems: COMMAND_ARG_CHOICES_MAX_ITEMS }),
    ),
    dynamic: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One command catalog entry visible to clients. */
export const CommandEntrySchema = Type.Object(
  {
    name: BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH),
    nativeName: Type.Optional(BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH)),
    textAliases: Type.Optional(
      Type.Array(BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH), {
        maxItems: COMMAND_ALIAS_MAX_ITEMS,
      }),
    ),
    description: Type.String({ maxLength: COMMAND_DESCRIPTION_MAX_LENGTH }),
    category: Type.Optional(CommandCategorySchema),
    source: CommandSourceSchema,
    scope: CommandScopeSchema,
    acceptsArgs: Type.Boolean(),
    args: Type.Optional(Type.Array(CommandArgSchema, { maxItems: COMMAND_ARGS_MAX_ITEMS })),
  },
  { additionalProperties: false },
);

/** Command catalog request filters. */
export const CommandsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    provider: Type.Optional(NonEmptyString),
    scope: Type.Optional(CommandScopeSchema),
    includeArgs: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Bounded command catalog response. */
export const CommandsListResultSchema = Type.Object(
  {
    commands: Type.Array(CommandEntrySchema, { maxItems: COMMAND_LIST_MAX_ITEMS }),
  },
  { additionalProperties: false },
);
