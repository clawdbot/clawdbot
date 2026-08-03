#!/usr/bin/env node
/**
 * Finds channel-specific references inside channel-agnostic protected sources.
 */
export function findChannelAgnosticBoundaryViolations(
  content: unknown,
  fileName?: string,
  options?: Record<string, unknown>,
): unknown[];
/**
 * Finds reverse dependencies from channel core into plugin/runtime surfaces.
 */
export function findChannelCoreReverseDependencyViolations(
  content: unknown,
  fileName?: string,
): unknown[];
/**
 * Finds user-facing channel names in ACP-owned text sources.
 */
export function findAcpUserFacingChannelNameViolations(
  content: unknown,
  fileName?: string,
): unknown[];
/**
 * Finds raw system mark literals where shared constants should be used.
 */
export function findSystemMarkLiteralViolations(content: unknown, fileName?: string): unknown[];
/**
 * Runs all channel-agnostic boundary checks.
 */
export function main(): Promise<void>;
