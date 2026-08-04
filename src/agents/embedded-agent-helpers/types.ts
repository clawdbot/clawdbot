/** Context file passed into embedded agents as preloaded workspace content. */
export type EmbeddedContextFile = { path: string; content: string };

/** Closed reason codes used by model failover and retry classification. */
export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "server_error"
  | "timeout"
  | "tls_certificate"
  | "context_overflow"
  | "model_not_found"
  | "session_expired"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";
