// Matches Node's NODE_OPTIONS grammar: literal-space delimiters, double quotes,
// and backslash escapes only inside quotes.
export function parseNodeOptionsEnvVar(value: string | undefined): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let inQuotes = false;
  const nodeOptions = value ?? "";

  for (let index = 0; index < nodeOptions.length; index += 1) {
    let char = nodeOptions.charAt(index);
    if (char === "\\" && inQuotes) {
      index += 1;
      if (index >= nodeOptions.length) {
        return null;
      }
      char = nodeOptions.charAt(index);
    } else if (char === " " && !inQuotes) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
      continue;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    token += char;
  }

  if (inQuotes) {
    return null;
  }
  if (token.length > 0) {
    tokens.push(token);
  }
  return tokens;
}
