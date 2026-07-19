#!/usr/bin/env node

export interface ReleaseEvidenceImpact {
  schemaVersion: 1;
  changeClass: "changelog-only" | "release-tooling" | "plugin-product" | "no-change" | "product";
  changedPaths: string[];
  reusableEvidencePolicy:
    | "changelog-only-release-v1"
    | "same-code-sha-tooling-retry-v1"
    | "exact-sha-v1"
    | "none";
  diagnosticRerunGroups: string[];
  finalPublishRequiresFullValidation: boolean;
}

export function classifyReleaseEvidenceImpact(paths: string[]): ReleaseEvidenceImpact;
