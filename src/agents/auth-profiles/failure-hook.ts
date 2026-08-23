/** Hook invoked when auth profile failure state changes. */
type AuthProfileFailureHook = () => void;

let authProfileFailureHook: AuthProfileFailureHook | undefined;

/** Installs or clears the process-local auth profile failure hook. */
export function setAuthProfileFailureHook(hook: AuthProfileFailureHook | undefined): void {
  authProfileFailureHook = hook;
}

/** Notifies the process-local auth profile failure hook. */
export function notifyAuthProfileFailureHook(): void {
  authProfileFailureHook?.();
}
