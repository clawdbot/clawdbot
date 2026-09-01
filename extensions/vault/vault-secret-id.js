const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;

export function parseVaultSecretId(id) {
  const parts = id.split("/");
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Vault SecretRef id "${id}" must not contain empty path segments.`);
  }
  if (!EXEC_SECRET_REF_ID_PATTERN.test(id)) {
    throw new Error(`Vault SecretRef id "${id}" contains unsupported characters.`);
  }
  if (parts.length < 2) {
    throw new Error(
      `Vault SecretRef id "${id}" must use "<path>/<field>", for example "providers/openai/apiKey".`,
    );
  }
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Vault SecretRef id "${id}" must not contain dot path segments.`);
  }
  return {
    secretPath: parts.slice(0, -1).join("/"),
    field: parts.at(-1),
  };
}
