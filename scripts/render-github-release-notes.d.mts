#!/usr/bin/env node
export function githubReleaseBodySize(body: unknown): {
  characters: number;
  bytes: number;
};
export function fitsGithubReleaseBody(body: unknown): boolean;
export function extractChangelogReleaseSections(changelog: string): {
  version: string;
  source: string;
}[];
export function extractChangelogSection(changelog: unknown, version: unknown): unknown;
export function releaseNotesVersionForTag(tag: unknown): unknown;
export function formatShippedBaselineExclusions(baselines: ShippedBaselineExclusion[]): string;
export function parseShippedBaselineExclusions(section: string): ShippedBaselineExclusion[];
export function tagPinnedContributionRecordUrl(repository: unknown, tag: unknown): string;
export function dedicatedSectionVersionForTag(tag: unknown): unknown;
export function releaseNotesSectionForTag(
  changelog: unknown,
  version: unknown,
  tag: unknown,
): unknown;
export function renderGithubReleaseNotes({
  changelog,
  version,
  tag,
  repository,
  verification,
}: {
  changelog: unknown;
  version: unknown;
  tag: unknown;
  repository: unknown;
  verification?: string | undefined;
}): {
  body: string;
  mode: string;
  size: {
    characters: number;
    bytes: number;
  };
  verificationIncluded: boolean;
  verificationOmitted: boolean;
};
export function verifyGithubReleaseNotes({
  body,
  changelog,
  version,
  tag,
  repository,
}: {
  body: unknown;
  changelog: unknown;
  version: unknown;
  tag: unknown;
  repository: unknown;
}): {
  matches: boolean;
  actualSize: {
    characters: number;
    bytes: number;
  };
  body: unknown;
  mode: string;
  size: {
    characters: number;
    bytes: number;
  };
  verificationIncluded: boolean;
  verificationOmitted: boolean;
};
export const GITHUB_RELEASE_BODY_MAX_CHARACTERS: 125000;
export const GITHUB_RELEASE_BODY_MAX_BYTES: 125000;
export type ShippedBaselineExclusion = {
  ref: string;
  count: number;
  pullRequests: number[];
};
