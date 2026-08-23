export const OPENCODE_SESSIONS_LIST_COMMAND = "opencode.sessions.list.v1";
export const OPENCODE_SESSION_READ_COMMAND = "opencode.sessions.read.v1";
export const OPENCODE_TERMINAL_RESUME_COMMAND = "opencode.terminal.resume.v1";

export const OPENCODE_SESSIONS_CAPABILITY = "opencode-sessions";
export const OPENCODE_LOCAL_SESSION_HOST_ID = "gateway";
export const OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT = 100;
export const OPENCODE_NODE_INVOKE_TIMEOUT_MS = 35_000;
export const OPENCODE_SESSION_ID_PATTERN = /^(?!-)[A-Za-z0-9._:-]{1,256}$/u;
