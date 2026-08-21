export type CandidateReceiptArtifact = {
  artifact_digest: string;
  artifact_id: string;
  artifact_name: string;
  content_digest: string;
};

export type CandidateReceipt = {
  schema: "openclaw.candidate-receipt.v1";
  release_plan_digest: string;
  producer: {
    repository: "openclaw/openclaw";
    workflow_path: ".github/workflows/release-candidate-artifacts.yml";
    workflow_id: string;
    workflow_sha: string;
    run_id: string;
    run_attempt: string;
  };
  artifacts: {
    docker_image: CandidateReceiptArtifact;
    e2e_plugin_registry: CandidateReceiptArtifact;
    package: CandidateReceiptArtifact;
    root_image: CandidateReceiptArtifact;
  };
};

export type CandidateReceiptLock = {
  schema: "openclaw.candidate-receipt-lock.v1";
  digest: string;
  receipt: CandidateReceipt;
};

export const CANDIDATE_RECEIPT_SCHEMA: "openclaw.candidate-receipt.v1";
export const CANDIDATE_RECEIPT_LOCK_SCHEMA: "openclaw.candidate-receipt-lock.v1";
export const CANDIDATE_RECEIPT_CANONICALIZATION: "ascii-sorted-compact-json-trailing-newline-v1";
export const CANDIDATE_RECEIPT_MAX_BYTES: number;
export const CANDIDATE_RECEIPT_WORKFLOW_PATH: ".github/workflows/release-candidate-artifacts.yml";
export function validateCandidateReceipt(value: unknown): CandidateReceipt;
export function canonicalCandidateReceiptJson(value: unknown): string;
export function candidateReceiptDigest(value: unknown): string;
export function createCandidateReceiptLock(value: unknown): CandidateReceiptLock;
export function validateCandidateReceiptLock(value: unknown): CandidateReceiptLock;
export function canonicalCandidateReceiptLockJson(value: unknown): string;
export function parseCandidateReceiptLockJson(text: string): CandidateReceiptLock;
