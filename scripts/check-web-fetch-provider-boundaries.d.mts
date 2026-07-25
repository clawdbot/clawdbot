#!/usr/bin/env node
/**
 * Collects web-fetch provider boundary violations in core source files.
 */
export function collectWebFetchProviderBoundaryViolations(): Promise<
  Array<{
    file: string;
    line: number;
    provider: string;
    reason: string;
  }>
>;
/**
 * Runs the web-fetch provider boundary check.
 */
export function main(argv: unknown, io: unknown): Promise<1 | 0>;
