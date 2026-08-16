/** Opaque cron execution identity retained without importing scheduler implementation types. */
export type AgentRunCronReceipt = Readonly<{
  receiptId: string;
  storeKey: string;
  jobId: string;
  configRevision: string;
  agentId: string;
  ownerPid: number;
  ownerStartTime: number | null;
  startedAtMs: number;
}>;

export type AgentRunClaimOwnership = {
  lifecycleGeneration: string;
  claimIds: Set<string>;
  /** Detached task ids exist only for the exact execution claims that own them. */
  taskRunIds?: Map<string, string>;
  /** Live execution claims are lifecycle-owned and must not be expired by the projection sweeper. */
  sweepProtectedClaimIds: Set<string>;
  preserveAfterRelease: boolean;
  clearRequested: boolean;
  exclusiveClaimId?: string;
  clearListeners?: Map<string, (claimId: string) => void>;
};

const cronReceiptsByRunId = new Map<string, Map<string, AgentRunCronReceipt>>();

export function bindAgentRunCronReceiptValue(
  runId: string,
  claimId: string,
  receipt: AgentRunCronReceipt,
  activeClaimIds: ReadonlySet<string> | undefined,
): boolean {
  if (!receipt.receiptId.trim() || !activeClaimIds?.has(claimId)) {
    return false;
  }
  const receipts = cronReceiptsByRunId.get(runId) ?? new Map();
  receipts.set(claimId, { ...receipt });
  cronReceiptsByRunId.set(runId, receipts);
  return true;
}

export function getAgentRunCronReceiptValue(
  runId: string,
  activeClaimIds: ReadonlySet<string> | undefined,
): AgentRunCronReceipt | undefined {
  const receipts = cronReceiptsByRunId.get(runId);
  const unique = new Map(
    [...(receipts ?? [])]
      .filter(([claimId]) => activeClaimIds?.has(claimId))
      .map(([, receipt]) => [receipt.receiptId, receipt]),
  );
  return unique.size === 1 ? unique.values().next().value : undefined;
}

export function releaseAgentRunCronReceiptValue(runId: string, claimId: string): void {
  const receipts = cronReceiptsByRunId.get(runId);
  receipts?.delete(claimId);
  if (receipts?.size === 0) {
    cronReceiptsByRunId.delete(runId);
  }
}

export function clearAgentRunCronReceiptValues(runId: string): void {
  cronReceiptsByRunId.delete(runId);
}

export function resetAgentRunCronReceiptValuesForTest(): void {
  cronReceiptsByRunId.clear();
}
