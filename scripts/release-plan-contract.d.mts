export type ReleasePlanPurpose =
  | "beta-publish"
  | "stable-publish"
  | "postpublish-confidence"
  | "main-qualification";

export type ReleasePlan = {
  schema: "openclaw.release-plan.v1";
  release_id: string;
  version: string;
  tag: string | null;
  candidate_sha: string;
  target_context_ref: string;
  purpose: ReleasePlanPurpose;
  tooling: {
    repository: "openclaw/openclaw";
    workflow_path: ".github/workflows/full-release-validation.yml";
    ref: string;
    sha: string;
  };
  validation: {
    profile: "beta" | "stable" | "full";
    soak: boolean;
    allowed_groups: string[];
    exceptions: Array<{ code: string; reason: string }>;
  };
  inventory: {
    packages: Array<{ name: string; version: string; targets: Array<"clawhub" | "npm"> }>;
    platforms: Array<{ id: string; source: string }>;
  };
};

export type ReleasePlanLock = {
  schema: "openclaw.release-plan-lock.v1";
  digest: string;
  plan: ReleasePlan;
};

export type ValidationAttemptRequest = {
  schema: "openclaw.validation-attempt-request.v1";
  plan_digest: string;
  rerun_group: string;
  filters: Record<string, string>;
  fail_fast: boolean;
  reuse_evidence: boolean;
};

export type ValidationAttemptReceipt = {
  schema: "openclaw.validation-attempt-receipt.v1";
  plan_digest: string;
  request_digest: string;
  run_id: string;
  run_attempt: string;
  workflow_ref: string;
  workflow_full_ref: string;
  workflow_sha: string;
  target_sha: string;
};

export const RELEASE_PLAN_SCHEMA: "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA: "openclaw.release-plan-lock.v1";
export const VALIDATION_ATTEMPT_REQUEST_SCHEMA: "openclaw.validation-attempt-request.v1";
export const VALIDATION_ATTEMPT_RECEIPT_SCHEMA: "openclaw.validation-attempt-receipt.v1";
export const RELEASE_PLAN_CANONICALIZATION: "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PLAN_MAX_BYTES: number;
export const VALIDATION_ATTEMPT_REQUEST_MAX_BYTES: number;
export function validateReleasePlan(value: unknown): ReleasePlan;
export function canonicalReleasePlanJson(value: unknown): string;
export function releasePlanDigest(value: unknown): string;
export function createReleasePlanLock(value: unknown): ReleasePlanLock;
export function validateReleasePlanLock(value: unknown): ReleasePlanLock;
export function canonicalReleasePlanLockJson(value: unknown): string;
export function parseReleasePlanLockJson(text: string): ReleasePlanLock;
export function validateValidationAttemptRequest(value: unknown): ValidationAttemptRequest;
export function validateValidationAttemptReceipt(value: unknown): ValidationAttemptReceipt;
