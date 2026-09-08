import type { UpdateCheckpointSharedPublication } from "../infra/update-checkpoint-publication-types.js";
/** The checkpoint describes facts; authority is the live lexical owners plus
 * retained physical custody. Every effect/reconciliation must finish before
 * returning: renewal after this window changes the bound lease rows.
 */
export type OpenClawStateLeasePublicationResult<T> = {
  result: T;
  publication: UpdateCheckpointSharedPublication;
};

/** Canonical-only recovery CAS inside a verified, still-physically-excluded
 * publication window. The async inspections stay outside the synchronous write.
 */
export type OpenClawStatePublicationWrite = (
  publication: UpdateCheckpointSharedPublication,
  write: (assertCurrent: () => void) => UpdateCheckpointSharedPublication["recoveryRecord"],
) => Promise<UpdateCheckpointSharedPublication>;
export type OpenClawStatePublicationOperation<T> = (
  assertCurrent: () => void,
  bindPublishedRecord: OpenClawStatePublicationWrite,
) => Promise<OpenClawStateLeasePublicationResult<T>>;
