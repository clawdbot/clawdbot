/** Secret-free provider auth facts captured by a prepared agent runtime. */
export type PreparedProviderAuthFact = Readonly<{
  mode: "api_key" | "oauth" | "token";
  runtime?: string;
}>;

export type PreparedProviderAuth = Readonly<Record<string, PreparedProviderAuthFact>>;
