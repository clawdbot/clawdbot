// Shared command argument shapes for auto-reply command parsing.
/** Primitive values accepted by parsed auto-reply command args. */
type CommandArgValue = string | number | boolean | bigint;
/** Named parsed auto-reply command values. */
export type CommandArgValues = Record<string, CommandArgValue>;

/** Parsed command argument bundle with raw source and structured values. */
export type CommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
