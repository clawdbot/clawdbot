import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runExec } from "../../process/exec.js";

type OpenPathCommand = {
  command: string;
  args: string[];
};

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''");
}

export function resolveOpenPathCommand(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): OpenPathCommand {
  if (platform === "win32") {
    // Use a PowerShell string literal so the path stays data, not code.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${escapePowerShellSingleQuotedString(targetPath)}'`,
      ],
    };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [targetPath],
  };
}

export async function execOpenPath(command: OpenPathCommand): Promise<void> {
  await runExec(command.command, command.args, { logOutput: false });
}

export function formatOpenPathError(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function isHeadlessOpenPathError(message: string): boolean {
  return message.includes("xdg-open") && message.includes("no method available");
}

export function sanitizePathForLog(targetPath: string): string {
  const sanitized = Array.from(targetPath, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : char;
  }).join("");
  return sanitized.length > 120 ? `${truncateUtf16Safe(sanitized, 117)}...` : sanitized;
}
