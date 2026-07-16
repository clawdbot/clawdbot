const WINDOWS_DIRECT_EXECUTABLE_PATH_RE =
  /^(?<command>(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]).*?\.(?:exe|com))(?=\s|$)(?:\s+(?<rest>.*))?$/i;

// Windows wrapper scripts need their host shell or interpreter (`cmd.exe`,
// `powershell.exe`, or `node`) instead of direct spawning.
const WINDOWS_WRAPPER_PATH_RE =
  /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]).*?\.(?:bat|cmd|cjs|js|mjs|ps1)$/i;

function splitCommandParts(value, platform = process.platform) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    const next = value[index + 1];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === "'") {
        current += ch;
        continue;
      }
      if (platform === "win32") {
        if (quote === '"') {
          if (next === '"' || next === "\\") {
            escaping = true;
            continue;
          }
          current += ch;
          continue;
        }
        if (!quote) {
          current += ch;
          continue;
        }
      }
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Invalid agent command: unterminated quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function splitWindowsExecutableCommand(value, platform = process.platform) {
  if (platform !== "win32") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return null;
  }
  const match = trimmed.match(WINDOWS_DIRECT_EXECUTABLE_PATH_RE);
  if (!match?.groups?.command) {
    return null;
  }
  const rest = match.groups.rest?.trim() ?? "";
  return {
    command: match.groups.command,
    args: rest ? splitCommandParts(rest, platform) : [],
  };
}

function assertSupportedWindowsCommand(command, platform = process.platform) {
  if (platform !== "win32" || !WINDOWS_WRAPPER_PATH_RE.test(command)) {
    return;
  }
  throw new Error(
    `Unsupported Windows agent command wrapper: ${command}. ` +
      "Invoke wrapper scripts through their shell or interpreter instead " +
      "(for example `cmd.exe /c`, `powershell.exe -File`, or `node <script>`).",
  );
}

export function splitCommandLine(value, platform = process.platform) {
  const windowsCommand = splitWindowsExecutableCommand(value, platform);
  const parts = windowsCommand ?? splitCommandParts(value, platform);
  if (parts.length === 0) {
    throw new Error("Invalid agent command: empty command");
  }
  const parsed = Array.isArray(parts)
    ? {
        command: parts[0],
        args: parts.slice(1),
      }
    : parts;
  assertSupportedWindowsCommand(parsed.command, platform);
  return parsed;
}
