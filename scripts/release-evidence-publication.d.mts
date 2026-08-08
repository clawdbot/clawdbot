export type ReleaseEvidencePublicationAssessment =
  | {
      reason: string;
      shouldDispatch: false;
    }
  | {
      fullValidationRunId: string;
      headSha: string;
      notes: string;
      packageSpec: string;
      publicationKey: string;
      reason: "requested";
      releaseId: string;
      releaseRef: string;
      runAttempt: number;
      shouldDispatch: true;
      updatedAt: string;
    };

export function assessReleaseEvidencePublication(params: {
  event: unknown;
  evidence: unknown;
}): ReleaseEvidencePublicationAssessment;

export function publishedReleaseEvidenceMatches(
  value: unknown,
  expected: Extract<ReleaseEvidencePublicationAssessment, { shouldDispatch: true }>,
): boolean;
