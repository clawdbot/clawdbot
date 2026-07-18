#!/usr/bin/env node
/**
 * Rewrites an image reference to use the provided digest.
 */
export function imageRefForDigest(imageRef: unknown, digest: unknown): string;
/**
 * Parses os/architecture[/variant] platform strings.
 */
export function parsePlatform(value: unknown): {
  architecture: unknown;
  os: unknown;
  variant: unknown;
};
/**
 * Collects missing/mismatched attestation errors for required image platforms.
 */
export function collectDockerAttestationErrors(params: unknown): string[];
export function inspectRaw(
  imageRef: unknown,
  params?: {
    execFileSyncImpl?: (command: string, args: string[], options: unknown) => string;
  },
): string;
export function parseArgs(argv: unknown): {
  help: boolean;
  imageRefs: unknown[];
  requiredPlatforms: {
    architecture: unknown;
    os: unknown;
    variant: unknown;
  }[];
};
