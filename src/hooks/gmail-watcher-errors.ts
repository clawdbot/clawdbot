const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

/** Detect watcher startup failures caused by an occupied bind port. */
export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}
