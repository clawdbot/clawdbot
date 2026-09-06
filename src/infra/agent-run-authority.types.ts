/** Exact admitted-run claim shared by the registry and its subordinate approval leases. */
export type AgentRunDelegatedAuthority = Readonly<{
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  lifecycleGeneration: string;
  claimId: string;
}>;
