import type { VerifiedReleasePlanLock } from "./release-plan-producer.mts";

export type ReleasePublicationPackageIdentity = {
  name: string;
  version: string;
};

export type ReleasePublicationEligibilityProvenance = {
  repository: string;
  workflow_path: string;
  workflow_ref: string;
  workflow_sha: string;
  run_id: string;
  run_attempt: number;
  job: string;
  artifact_id: string;
  artifact_digest: string;
};

export type ReleasePublicationEligibilityReceipt = {
  schema: "openclaw.release-publication-eligibility.v1";
  evidence_scope: "validation-start-only";
  publication_authorized: false;
  release_plan_digest: string;
  started_at: string;
  completed_at: string;
  expires_at: string;
  registries: {
    clawhub: "https://clawhub.ai";
    npm: "https://registry.npmjs.org";
  };
  provenance: ReleasePublicationEligibilityProvenance;
  observations: {
    latest_dependencies: Array<{
      name: string;
      required_version: string;
      observed_version: string;
    }>;
    npm: Array<ReleasePublicationPackageIdentity & { published: boolean }>;
    clawhub: Array<
      ReleasePublicationPackageIdentity & {
        package_exists: boolean;
        trusted_publisher: boolean;
        published: boolean;
      }
    >;
  };
  plans: {
    npm: Array<ReleasePublicationPackageIdentity & { status: "vacant" | "already-published" }>;
    clawhub: Array<ReleasePublicationPackageIdentity & { status: "vacant" | "already-published" }>;
  };
  digest: string;
};

export type ReleasePublicationEligibilityReceiptBody = Omit<
  ReleasePublicationEligibilityReceipt,
  "digest"
>;

export const RELEASE_PUBLICATION_ELIGIBILITY_CANONICALIZATION: "ascii-sorted-compact-json-trailing-newline-v1";
export const RELEASE_PUBLICATION_ELIGIBILITY_MAX_AGE_MS: number;
export const RELEASE_PUBLICATION_ELIGIBILITY_EVIDENCE_SCOPE: "validation-start-only";
export const RELEASE_PUBLICATION_ELIGIBILITY_WORKFLOW_PATH: ".github/workflows/release-publication-eligibility.yml";
export const RELEASE_PUBLICATION_NPM_REGISTRY: "https://registry.npmjs.org";
export const RELEASE_PUBLICATION_CLAWHUB_REGISTRY: "https://clawhub.ai";

export function createReleasePublicationEligibilityReceipt(
  value: unknown,
): ReleasePublicationEligibilityReceipt;
export function canonicalReleasePublicationEligibilityReceiptJson(value: unknown): string;
export function parseReleasePublicationEligibilityReceiptJson(
  text: string,
): ReleasePublicationEligibilityReceipt;
export function verifyReleasePublicationEligibilityReceipt(
  value: unknown,
  releasePlanLock: VerifiedReleasePlanLock,
  expectedProvenance: ReleasePublicationEligibilityProvenance,
  nowMs?: number,
): ReleasePublicationEligibilityReceipt;
