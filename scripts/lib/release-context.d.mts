import type { parseReleaseVersion } from "./release-version.mjs";

type ReleaseContextKind = "release branch" | "extended-stable branch" | "release tag";

export function parseReleaseContextRef(contextRef: string): {
  kind: ReleaseContextKind;
  ref: string;
  version: NonNullable<ReturnType<typeof parseReleaseVersion>>;
} | null;
export function releaseBranchForTag(tag: string): string;
export function resolveReleaseContextIdentity(
  contextRef: string,
  packageVersion: string,
): { kind: ReleaseContextKind; releaseTag: string; baseTag: string | null } | null;
