import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runExec, spawnCommand } from "../../process/exec.js";

const OPEN_PATH_TIMEOUT_MS = 5_000;
const XDG_OPEN_STARTUP_OBSERVATION_MS = 5_000;
const XDG_OPEN_STDERR_MAX_CHARS = 4_096;

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

async function observeXdgOpenStartup(command: OpenPathCommand): Promise<void> {
  // xdg-open can synchronously own a foreground application. Observe startup
  // failures without making the Gateway own the launched application's lifetime.
  const child = spawnCommand([command.command, ...command.args], {
    buffer: false,
    cleanup: false,
    detached: true,
    reject: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.unref();
  let stderrText = "";
  const stderr = child.stderr;
  stderr?.setEncoding("utf8");
  const onStderr = (chunk: string | Buffer) => {
    if (stderrText.length >= XDG_OPEN_STDERR_MAX_CHARS) {
      return;
    }
    stderrText += String(chunk).slice(0, XDG_OPEN_STDERR_MAX_CHARS - stderrText.length);
  };
  stderr?.on("data", onStderr);

  await new Promise<void>((resolve, reject) => {
    let observationComplete = false;
    const releaseStderr = (childSettled: boolean) => {
      stderr?.off("data", onStderr);
      if (childSettled) {
        stderr?.destroy();
        return;
      }
      // Keep draining after the observation window. Closing the pipe can send
      // SIGPIPE to a foreground application that writes diagnostics later.
      stderr?.resume();
      (stderr as (typeof stderr & { unref?: () => void }) | null)?.unref?.();
    };
    const timer = setTimeout(() => {
      observationComplete = true;
      releaseStderr(false);
      resolve();
    }, XDG_OPEN_STARTUP_OBSERVATION_MS);
    void child.then(
      () => {
        clearTimeout(timer);
        releaseStderr(true);
        if (!observationComplete) {
          resolve();
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        releaseStderr(true);
        if (observationComplete) {
          return;
        }
        const commandError = error instanceof Error ? error : new Error(String(error));
        const diagnostic = stderrText.trim();
        reject(
          diagnostic
            ? new Error(`${commandError.message}: ${diagnostic}`, { cause: commandError })
            : commandError,
        );
      },
    );
  });
}

export async function execOpenPath(
  command: OpenPathCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "linux") {
    await observeXdgOpenStartup(command);
    return;
  }
  await runExec(command.command, command.args, {
    logOutput: false,
    timeoutMs: OPEN_PATH_TIMEOUT_MS,
  });
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
