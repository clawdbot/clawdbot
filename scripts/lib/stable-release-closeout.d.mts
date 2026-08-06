export function parseStableReleaseTag(tag: unknown): string;
export function extractStableChangelogSection(changelog: unknown, version: unknown): unknown;
export function verifyStableMainCloseout(params: unknown):
  | {
      errors: string[];
      manifest: null;
    }
  | {
      errors: string[];
      manifest: {
        version: number;
        releaseTag: unknown;
        releaseVersion: unknown;
        releaseTagSha: unknown;
        mainSha: unknown;
        mainPackageVersion: string;
        releaseTagPackageVersion: string;
        changelogSha256: string;
        appcastSha256: string;
        fullReleaseValidationRunId: unknown;
        fullReleaseValidationRunAttempt: unknown;
        releasePublishRunId: unknown;
        rollbackDrill: {
          id: unknown;
          date: unknown;
        };
        githubReleaseAssets: unknown;
      };
    };
