// Shell startup files overwrite PATH before the payload runs (a login profile
// such as Debian `/etc/profile`, or an RC file such as `~/.zshenv`), so the
// gateway exec wrapper and the node-host spawn boundary both re-apply their own
// PATH afterwards, carried in an env var so it never reaches shell syntax. The
// key and the `${PATH:+:$PATH}` guard -- an unset PATH must not leave a
// trailing `:`, which means cwd -- have to stay identical at both call sites.

/** Env key holding the PATH to re-apply once shell startup files have run. */
export const LOGIN_SHELL_PATH_CARRIER_ENV = "OPENCLAW_PREPEND_PATH";

/** Prefix a POSIX shell payload with the carrier PATH re-application. */
export function prependCarrierPathToShellPayload(payload: string): string {
  return `export PATH="\${${LOGIN_SHELL_PATH_CARRIER_ENV}}\${PATH:+:$PATH}"; unset ${LOGIN_SHELL_PATH_CARRIER_ENV}; ${payload}`;
}
