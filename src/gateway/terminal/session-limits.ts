/** Bounds concurrent shells so a client cannot exhaust host processes. */
export const DEFAULT_MAX_SESSIONS = 24;
/**
 * Rolling output retained per session for reattach replay and terminal.text,
 * in UTF-16 code units. The session cap keeps worst-case memory bounded.
 */
export const DEFAULT_SCROLLBACK_CHARS = 256 * 1024;
/**
 * Detached-session cap; the oldest parked shell is killed to keep repeated
 * disconnects from parking the full session cap of headless shells.
 */
export const DEFAULT_MAX_DETACHED_SESSIONS = 8;
/** Default grace period before a detached session is killed (seconds). */
export const DEFAULT_TERMINAL_DETACH_SECONDS = 300;
