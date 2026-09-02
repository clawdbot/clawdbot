// Detects remote/container environments where local desktop UX is unavailable.
import { isWSLEnv } from "./wsl.js";

// Remote environment detection gates local UX that depends on a desktop session
// or direct host access.
export function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }

  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }

  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY &&
    !isWSLEnv()
  ) {
    return true;
  }

  return false;
}
