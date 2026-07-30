#!/usr/bin/env node
export function buildWebUiChatEvidenceManifest({
  candidateRef,
  candidateSha,
  status,
}: {
  candidateRef: unknown;
  candidateSha: unknown;
  status: unknown;
}): {
  schemaVersion: number;
  id: string;
  title: string;
  summary: string;
  scenario: string;
  comparison: {
    candidate: {
      expected: string;
      status: unknown;
      fixed: boolean;
      ref?: unknown;
      sha?: unknown;
    };
    pass: boolean;
  };
  artifacts: (
    | {
        alt?: unknown;
        inline?: boolean | undefined;
        width?: number | undefined;
        kind: unknown;
        lane: string;
        label: unknown;
        path: unknown;
        targetPath: unknown;
        required: unknown;
      }
    | {
        kind: string;
        lane: string;
        label: string;
        path: string;
        targetPath: string;
      }
  )[];
};
export function writeWebUiChatEvidence(rawArgs?: string[]): {
  manifest: {
    schemaVersion: number;
    id: string;
    title: string;
    summary: string;
    scenario: string;
    comparison: {
      candidate: {
        expected: string;
        status: unknown;
        fixed: boolean;
        ref?: unknown;
        sha?: unknown;
      };
      pass: boolean;
    };
    artifacts: (
      | {
          alt?: unknown;
          inline?: boolean | undefined;
          width?: number | undefined;
          kind: unknown;
          lane: string;
          label: unknown;
          path: unknown;
          targetPath: unknown;
          required: unknown;
        }
      | {
          kind: string;
          lane: string;
          label: string;
          path: string;
          targetPath: string;
        }
    )[];
  };
  manifestPath: string;
  reportPath: string;
};
