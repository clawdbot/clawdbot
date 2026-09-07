import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStatePublicationOperation } from "./openclaw-state-publication-types.js";

export type OpenClawStateMutationOperation<T, R> = {
  /** Fresh executor authority. Checked by every coordinated canonical write. */
  assertCurrent: () => void;
  mutate: (assertCurrent: () => void) => Promise<T>;
  capture: (mutated: T, assertCurrent: () => void) => Promise<R>;
  bind: (captured: R, assertCurrent: () => void) => undefined;
};

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
  /** Asynchronous canonical mutation under physical exclusion, followed by
   * owner-held capture and synchronous binding before writers resume. */
  withDatabaseFileMutation?<T, R>(
    this: void,
    operation: OpenClawStateMutationOperation<T, R>,
  ): Promise<R>;
  /** Drain the heartbeat and capture while the original durable lease remains live. */
  withDatabaseFileExclusion?<T>(
    this: void,
    operation: (assertCurrent: () => void) => Promise<T>,
    bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
  ): Promise<T>;
  /** Distinct checkpoint publication window. All effects/reconciliation precede
   * rebind/renewal; failure disables ordinary cleanup on unverified canonical data. */
  withDatabaseFilePublication?<T>(
    this: void,
    operation: OpenClawStatePublicationOperation<T>,
  ): Promise<T>;
  /** Renew or verify independent renewal before another blocking phase. */
  renew?(): void;
  /** Verify that this exact owner holds a non-expired lease at this instant. */
  assertOwned(): void;
  /** Verify ownership using the caller's active write transaction. */
  assertOwnedInTransaction(database: DatabaseSync): void;
};
