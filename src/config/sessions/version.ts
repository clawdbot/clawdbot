/** Old transcripts retain their model projection; only new sessions select version 4. */
export const CURRENT_SESSION_VERSION = 4;
/** Version 3 remains readable without migration or a change to its provider prefix. */
export const MIN_READABLE_SESSION_VERSION = 3;
