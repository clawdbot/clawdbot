/** Windows cmd `set` assignment renderer/parser for managed service scripts. */
type CmdSetAssignment = { key: string; value: string };

/** Rejects line breaks before rendering values into Windows cmd scripts. */
export function assertNoCmdLineBreak(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} cannot contain CR or LF in Windows task scripts.`);
  }
}

function escapeCmdSetAssignmentComponent(value: string, delayedExpansion: boolean): string {
  // Keep the service-script encoding/readback contract by default. A launcher
  // that disables delayed expansion must not insert literal carets into paths.
  const escaped = delayedExpansion ? value.replace(/\^/g, "^^").replace(/!/g, "^!") : value;
  return escaped.replace(/%/g, "%%").replace(/"/g, '^"');
}

function unescapeCmdSetAssignmentComponent(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (ch === "^" && (next === "^" || next === '"' || next === "!")) {
      out += next;
      i += 1;
      continue;
    }
    if (ch === "%" && next === "%") {
      out += "%";
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseCmdSetAssignment(
  line: string,
  requireLiteral = false,
): CmdSetAssignment | null {
  const raw = requireLiteral ? line.trimStart() : line.trim();
  if (!raw) {
    return null;
  }
  const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
  const assignment = quoted ? raw.slice(1, -1) : raw;
  const index = assignment.indexOf("=");
  if (index <= 0) {
    return null;
  }
  const key = assignment.slice(0, index).trim();
  const value = requireLiteral ? assignment.slice(index + 1) : assignment.slice(index + 1).trim();
  if (!key) {
    return null;
  }
  // Batch expansions and caret/quote decoding depend on the command processor.
  // Strict service inspection must not report those expressions as effective facts.
  if (
    requireLiteral &&
    (key !== assignment.slice(0, index) ||
      /[%!^"]/.test(assignment.replace(/%%/g, "")) ||
      (!quoted && (assignment.startsWith("/") || /[&|<>()]/.test(assignment))))
  ) {
    return null;
  }
  if (!quoted && !requireLiteral) {
    return { key, value };
  }
  // Recovery decodes managed-script escapes; validated literal input can only
  // contain paired percent escapes, including in unquoted assignments.
  return {
    // Windows names are case-insensitive; strict maps keep the last assignment.
    key: unescapeCmdSetAssignmentComponent(requireLiteral ? key.toUpperCase() : key),
    value: unescapeCmdSetAssignmentComponent(value),
  };
}

export function renderCmdSetAssignment(
  key: string,
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string {
  assertNoCmdLineBreak(key, "Environment variable name");
  assertNoCmdLineBreak(value, "Environment variable value");
  const escapedKey = escapeCmdSetAssignmentComponent(key, options.delayedExpansion !== false);
  const escapedValue = escapeCmdSetAssignmentComponent(value, options.delayedExpansion !== false);
  return `set "${escapedKey}=${escapedValue}"`;
}
