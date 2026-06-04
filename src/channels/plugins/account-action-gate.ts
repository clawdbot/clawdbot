/**
 * Resolves whether an account-scoped action is enabled.
 */
export type ActionGate<T extends Record<string, boolean | undefined>> = (
  key: keyof T,
  defaultValue?: boolean,
) => boolean;

/**
 * Creates an action gate where account-specific flags override channel-level defaults.
 */
export function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
  baseActions?: T;
  accountActions?: T;
}): ActionGate<T> {
  return (key, defaultValue = true) => {
    const accountValue = params.accountActions?.[key];
    if (accountValue !== undefined) {
      return accountValue;
    }
    // Channel defaults apply only when the account did not explicitly set the action.
    const baseValue = params.baseActions?.[key];
    if (baseValue !== undefined) {
      return baseValue;
    }
    return defaultValue;
  };
}
