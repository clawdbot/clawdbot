#!/usr/bin/env node
/**
 * Reports whether a handle is forbidden in changelog thanks text.
 */
export function isForbiddenChangelogThanksHandle(
  handle: unknown,
  options?: Record<string, unknown>,
): boolean;
/**
 * Reports whether a handle needs a separate human credit.
 */
export function requiresExplicitHumanChangelogThanks(handle: unknown): boolean;
/**
 * Finds changelog lines that thank forbidden handles.
 */
export function findForbiddenChangelogThanks(content: unknown): unknown;
/**
 * Runs the changelog attribution check.
 */
export function main(argv?: string[]): Promise<void>;
