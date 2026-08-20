// Browser-safe subset of dotenv v17's parser contract; the package entrypoint
// also imports Node-only config/decryption helpers that cannot ship in Control UI.
const DOTENV_ASSIGNMENT_RE =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gmu;

/** Parse dotenv assignments, including quoted multi-line values, without Node built-ins. */
export function parseSecretStoreDotEnvText(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const normalized = raw.replace(/\r\n?/gu, "\n");
  DOTENV_ASSIGNMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOTENV_ASSIGNMENT_RE.exec(normalized)) !== null) {
    const key = match[1];
    if (!key) {
      continue;
    }
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gmu, "$2");
    if (quote === '"') {
      value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r");
    }
    entries[key] = value;
  }
  return entries;
}
