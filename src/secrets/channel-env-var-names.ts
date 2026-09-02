/** Ambient process env names that are too common to imply channel configuration. */
const UNSAFE_CHANNEL_ENV_VAR_TRIGGER_NAMES = new Set([
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_ENV",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

/**
 * Returns whether a channel env var name is safe to treat as a credential/config trigger.
 */
export function isSafeChannelEnvVarTriggerName(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  // Common process env names are too noisy; channel scans should only react to explicit secrets.
  return (
    /^[A-Z][A-Z0-9_]*$/.test(normalized) && !UNSAFE_CHANNEL_ENV_VAR_TRIGGER_NAMES.has(normalized)
  );
}
