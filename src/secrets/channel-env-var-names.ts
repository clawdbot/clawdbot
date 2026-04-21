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

export function isSafeChannelEnvVarTriggerName(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    /^[A-Z][A-Z0-9_]*$/.test(normalized) && !UNSAFE_CHANNEL_ENV_VAR_TRIGGER_NAMES.has(normalized)
  );
}
