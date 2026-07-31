#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  base: string;
  head: string;
};
export type TermMatch = {
  file: string;
  line: number;
  kind: "title" | "link label";
  term: string;
};
