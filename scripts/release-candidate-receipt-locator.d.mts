import type { CandidateReceiptLock } from "./release-candidate-receipt-contract.mjs";

type RunGh = (args: string[]) => string;

export type CandidateReceiptLocatorOptions = {
  dispatchId: string;
  releasePlanDigest: string;
  repo: string;
  runAttempt?: string;
  runGh?: RunGh;
  runId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  workflowId: string;
  workflowSha: string;
};

export function validateCandidateReceiptProvenance(params: {
  artifacts: unknown;
  expectedDispatchId: string;
  expectedReleasePlanDigest: string;
  expectedRunAttempt: string;
  expectedRunId: string;
  expectedWorkflowId: string;
  expectedWorkflowSha: string;
  lock: CandidateReceiptLock;
  run: unknown;
  workflow: unknown;
}): CandidateReceiptLock;
export function runCandidateReceiptGh(
  args: string[],
  params?: {
    execFileSyncImpl?: (
      command: string,
      args: string[],
      options: {
        encoding: "utf8";
        killSignal: "SIGKILL";
        maxBuffer: number;
        timeout: number;
      },
    ) => string;
  },
): string;
export function locateCandidateReceipt(
  options: CandidateReceiptLocatorOptions,
): Promise<CandidateReceiptLock>;
