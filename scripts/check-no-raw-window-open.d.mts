#!/usr/bin/env node
/**
 * Finds raw `window.open(...)` or `globalThis.open(...)` call lines.
 */
export function findRawWindowOpenLines(content: unknown, fileName?: string): unknown[];
/**
 * Runs the raw window.open guard.
 */
export function main(): Promise<void>;
