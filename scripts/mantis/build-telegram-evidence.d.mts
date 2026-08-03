#!/usr/bin/env node
/**
 * Renders a self-contained Telegram evidence HTML report.
 */
export function renderTelegramEvidenceHtml({
  observedMessages,
  summary,
}: {
  observedMessages: unknown;
  summary: unknown;
}): string;
export function buildTelegramEvidenceManifest({
  candidateRef,
  candidateSha,
  hasObservedMessages,
  scenarioLabel,
  summary,
  summaryArtifactPath,
}: {
  candidateRef: unknown;
  candidateSha: unknown;
  hasObservedMessages?: boolean | undefined;
  scenarioLabel: unknown;
  summary: unknown;
  summaryArtifactPath?: string | undefined;
}): {
  schemaVersion: number;
  id: string;
  title: string;
  summary: string;
  scenario: unknown;
  comparison: {
    candidate: {
      expected: string;
      status: string;
      fixed: boolean;
      ref?: unknown;
      sha?: unknown;
    };
    pass: boolean;
  };
  artifacts: (
    | {
        kind: string;
        lane: string;
        label: string;
        path: string;
        targetPath: string;
        alt: string;
        width: number;
        inline: boolean;
        required: boolean;
      }
    | {
        kind: string;
        lane: string;
        label: string;
        path: string;
        targetPath: string;
        required: boolean;
        alt?: undefined;
        width?: undefined;
        inline?: undefined;
      }
    | {
        kind: string;
        lane: string;
        label: string;
        path: string;
        targetPath: string;
        alt?: undefined;
        width?: undefined;
        inline?: undefined;
        required?: undefined;
      }
  )[];
};
export function writeTelegramEvidence(rawArgs?: string[]): {
  manifest: {
    schemaVersion: number;
    id: string;
    title: string;
    summary: string;
    scenario: unknown;
    comparison: {
      candidate: {
        expected: string;
        status: string;
        fixed: boolean;
        ref?: unknown;
        sha?: unknown;
      };
      pass: boolean;
    };
    artifacts: (
      | {
          kind: string;
          lane: string;
          label: string;
          path: string;
          targetPath: string;
          alt: string;
          width: number;
          inline: boolean;
          required: boolean;
        }
      | {
          kind: string;
          lane: string;
          label: string;
          path: string;
          targetPath: string;
          required: boolean;
          alt?: undefined;
          width?: undefined;
          inline?: undefined;
        }
      | {
          kind: string;
          lane: string;
          label: string;
          path: string;
          targetPath: string;
          alt?: undefined;
          width?: undefined;
          inline?: undefined;
          required?: undefined;
        }
    )[];
  };
  manifestPath: string;
  transcriptPath: string;
};
