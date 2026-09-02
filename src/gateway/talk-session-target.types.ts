// Keep shared Talk identity independent of the storage runtime used to prepare it.
export type PreparedTalkSessionTarget = Readonly<{
  agentId: string;
  /** Voice records and close/resume retain the client's exact key, not its storage alias. */
  sessionKey: string;
  canonicalKey: string;
  storePath: string;
}>;
