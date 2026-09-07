/** Secret-free credential modes captured by a prepared agent runtime. */
export type PreparedAgentCredentialModes = Readonly<Record<string, "api_key" | "oauth" | "token">>;
