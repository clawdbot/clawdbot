/**
 * A selected auth profile could not be staged by its CLI backend.
 * Backends must not use this for local preparation or transport failures:
 * core treats it as evidence that the exact profile should be quarantined.
 */
export class CliBackendAuthProfilePreparationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "CliBackendAuthProfilePreparationError";
  }
}
