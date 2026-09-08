import { mergeProcessEnv, resolveDiagnosticProcessEnv } from "../infra/process-env.js";

const SERVICE_MANAGER_ENV_KEYS = new Set([
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  // Linux bus/account routing, unit lookup and native client operation controls.
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SYSTEM_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "SYSTEMD_UNIT_PATH",
  "SUDO_USER",
  "SUDO_UID",
  "SUDO_GID",
  "SYSTEMD_OFFLINE",
  "SYSTEMD_IN_CHROOT",
  "SYSTEMD_BUS_TIMEOUT",
]);

/** Native controls receive OS context; service definitions and payloads keep their own env. */
export function resolveServiceManagerEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const native = resolveDiagnosticProcessEnv(source);
  for (const [key, value] of Object.entries(mergeProcessEnv([source]))) {
    if (SERVICE_MANAGER_ENV_KEYS.has(process.platform === "win32" ? key.toUpperCase() : key)) {
      native[key] = value;
    }
  }
  return native;
}
