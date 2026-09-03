// Owns strict CLI account selection for state-mutating channel commands.
export function assertAccountSelectorForMutation(account: string | undefined): void {
  // Only omission selects the default account. Blank input often comes from an unset
  // shell variable and must fail before channel setup, auth, or removal mutates state.
  if (account !== undefined && !account.trim()) {
    throw new Error("--account must not be blank");
  }
}
