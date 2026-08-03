/** Canonical id for file secret providers that expose exactly one value. */
export const SINGLE_VALUE_FILE_REF_ID = "value";

/** Shared alias grammar for env/file/exec secret provider names. */
export const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** JSON-schema fragment that rejects absolute file secret ref ids. */
export const FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN = "^/";
/** JSON-schema fragment that rejects invalid JSON-pointer escape sequences. */
export const FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN = "~(?:[^01]|$)";
/** JSON-schema pattern for exec secret ref ids, excluding dot-path traversal. */
export const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN =
  "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$";
