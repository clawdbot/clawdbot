type CmdSetAssignment = { key: string; value: string };

export function assertNoCmdLineBreak(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} cannot contain CR or LF in Windows task scripts.`);
  }
}

function escapeCmdSetAssignmentComponent(value: string): string {
  return value.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/!/g, "^!").replace(/"/g, '^"');
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

export function parseCmdSetAssignment(line: string): CmdSetAssignment | null {
  const raw = line.trim();
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
  const value = assignment.slice(index + 1).trim();
  if (!key) {
    return null;
  }
  if (!quoted) {
    return { key, value };
  }
  return {
    key: unescapeCmdSetAssignmentComponent(key),
    value: unescapeCmdSetAssignmentComponent(value),
  };
}

export function renderCmdSetAssignment(key: string, value: string): string {
  assertNoCmdLineBreak(key, "Environment variable name");
  assertNoCmdLineBreak(value, "Environment variable value");
  const escapedKey = escapeCmdSetAssignmentComponent(key);
  const escapedValue = escapeCmdSetAssignmentComponent(value);
  return `set "${escapedKey}=${escapedValue}"`;
}
