/** Session-identity fence failures for ACP transcript persistence. */

/**
 * Thrown when session identity diverged before a turn could be persisted
 * (missing entry, rebound session). Unlike operational I/O failures, these
 * stay visible to the caller instead of being logged away, because writing
 * anyway would attach the turn to the wrong session.
 */
export class AcpTranscriptSessionFenceError extends Error {}
