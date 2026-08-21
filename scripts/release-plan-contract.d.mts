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

export const RELEASE_PLAN_SCHEMA: "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA: "openclaw.release-plan-lock.v1";
export const RELEASE_PLAN_CANONICALIZATION: "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PLAN_MAX_BYTES: number;
export function validateReleasePlan(value: unknown): ReleasePlan;
export function canonicalReleasePlanJson(value: unknown): string;
export function releasePlanDigest(value: unknown): string;
export function createReleasePlanLock(value: unknown): ReleasePlanLock;
export function validateReleasePlanLock(value: unknown): ReleasePlanLock;
export function canonicalReleasePlanLockJson(value: unknown): string;
export function parseReleasePlanLockJson(text: string): ReleasePlanLock;
