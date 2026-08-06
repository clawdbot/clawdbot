#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  target: string;
  sourceRepo: string;
  sourceSha: string;
  clawhubRepo: string;
  clawhubSourceRepo: string;
  clawhubSourceSha: string;
};
/**
 * Resolves the local ClawHub repository path used for docs mirroring.
 */
export function resolveClawHubRepoPath(value?: string, options?: Record<string, unknown>): string;
/** Reports locale pages whose canonical source page no longer exists without deleting them. */
export function reportOrphanLocaleDocs(targetDocsDir: string): number;
/** Applies translated tab and group labels without replacing canonical page routes. */
export function applyLocaleNavLabelOverlay(
  fullNav: Record<string, unknown>,
  labelOverlay: Record<string, unknown>,
): Record<string, unknown>;
/** Composes the publish docs configuration with generated locale navigation. */
export function composeDocsConfig(): Record<string, unknown>;
/** Writes the public heading map into the publish tree without committing an expanded mirror. */
export function writePublishedDocsMap(targetDocsDir: string): string;
/**
 * Mirrors ClawHub docs into the target docs tree.
 */
export function syncClawHubDocsTree(
  targetDocsDir: unknown,
  options?: Record<string, unknown>,
): {
  repository: unknown;
  sha: unknown;
  path: string;
  files: number;
};
