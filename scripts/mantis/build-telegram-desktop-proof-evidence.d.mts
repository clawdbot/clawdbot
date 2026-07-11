#!/usr/bin/env node
/**
 * Builds the manifest for paired baseline/candidate Telegram Desktop proof artifacts.
 */
export function buildTelegramDesktopProofManifest({
  baseline,
  baselineRef,
  baselineSha,
  candidate,
  candidateRef,
  candidateSha,
  scenarioLabel,
}: {
  baseline: unknown;
  baselineRef: unknown;
  baselineSha: unknown;
  candidate: unknown;
  candidateRef: unknown;
  candidateSha: unknown;
  scenarioLabel: unknown;
}): {
  schemaVersion: number;
  id: string;
  title: string;
  summary: string;
  scenario: unknown;
  comparison: {
    baseline: {
      expected: string;
      status: string;
      ref?: unknown;
      sha?: unknown;
    };
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
        alt: string;
        inline: boolean;
        kind: string;
        label: string;
        lane: string;
        path: string;
        targetPath: string;
        width: number;
        required?: undefined;
      }
    | {
        kind: string;
        label: string;
        lane: string;
        path: string;
        required: boolean;
        targetPath: string;
        alt?: undefined;
        inline?: undefined;
        width?: undefined;
      }
    | {
        alt: string;
        inline: boolean;
        kind: string;
        label: string;
        lane: string;
        path: string;
        required: boolean;
        targetPath: string;
        width?: undefined;
      }
    | {
        kind: string;
        label: string;
        lane: string;
        path: string;
        targetPath: string;
        alt?: undefined;
        inline?: undefined;
        width?: undefined;
        required?: undefined;
      }
  )[];
};
export function writeTelegramDesktopProofEvidence(rawArgs?: string[]): {
  manifest: {
    schemaVersion: number;
    id: string;
    title: string;
    summary: string;
    scenario: unknown;
    comparison: {
      baseline: {
        expected: string;
        status: string;
        ref?: unknown;
        sha?: unknown;
      };
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
          alt: string;
          inline: boolean;
          kind: string;
          label: string;
          lane: string;
          path: string;
          targetPath: string;
          width: number;
          required?: undefined;
        }
      | {
          kind: string;
          label: string;
          lane: string;
          path: string;
          required: boolean;
          targetPath: string;
          alt?: undefined;
          inline?: undefined;
          width?: undefined;
        }
      | {
          alt: string;
          inline: boolean;
          kind: string;
          label: string;
          lane: string;
          path: string;
          required: boolean;
          targetPath: string;
          width?: undefined;
        }
      | {
          kind: string;
          label: string;
          lane: string;
          path: string;
          targetPath: string;
          alt?: undefined;
          inline?: undefined;
          width?: undefined;
          required?: undefined;
        }
    )[];
  };
  manifestPath: string;
};
