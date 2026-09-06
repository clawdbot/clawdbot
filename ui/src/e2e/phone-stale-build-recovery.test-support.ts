export function phoneProofCleanup(cleanup: () => Promise<void>): AsyncDisposable {
  return { [Symbol.asyncDispose]: cleanup };
}
