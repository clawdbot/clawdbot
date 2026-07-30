#!/usr/bin/env node
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
