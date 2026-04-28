export const VALID_FILE_SECRET_REF_IDS = [
  "value",
  "/",
  "//",
  "/providers/openai/apiKey",
  "/providers//apiKey",
  "/~0/~1",
  `//${"/".repeat(256)}`,
] as const;

export const INVALID_FILE_SECRET_REF_IDS = [
  "",
  "providers/openai/apiKey",
  "value/extra",
  "/providers/openai/apiKey~",
  "/providers/openai/apiKey~2",
  "/providers/openai/~",
] as const;

export const VALID_EXEC_SECRET_REF_IDS = [
  "vault/openai/api-key",
  "vault:secret/mykey",
  "providers/openai/apiKey",
  "a..b/c",
  "a/.../b",
  "a/.well-known/key",
  `a/${"b".repeat(254)}`,
] as const;

export const INVALID_EXEC_SECRET_REF_IDS = [
  "",
  " ",
  "a/../b",
  "a/./b",
  "../b",
  "./b",
  "a/..",
  "a/.",
  "/absolute/path",
  "bad id",
  "a\\b",
  `a${"b".repeat(256)}`,
] as const;
