#!/usr/bin/env node
export function parseArgs(argv: string[]): {
  staged: boolean;
  base: string;
  head: string;
  paths: string[];
};
export function main(argv?: string[]): void;
