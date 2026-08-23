/**
 * Shared built-in session tool input/detail contracts.
 *
 * Keeps tool factories, renderers, and callers aligned on typed payload and metadata shapes.
 */
import type { Edit } from "./edit-diff.js";
import type { TruncationResult } from "./truncate.js";

export interface BashToolInput {
  command: string;
  timeout?: number;
}

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function formatFullOutputFooter(path: string): string {
  return `Full output: ${path}`;
}

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

export type EditToolDetails =
  | {
      changed: false;
    }
  | {
      changed: true;
      /** Display-oriented diff of the changes made */
      diff: string;
      /** Standard unified patch of the changes made */
      patch: string;
      /** Line number of the first change in the new file (for editor navigation) */
      firstChangedLine?: number;
    };

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

export interface LsToolInput {
  path?: string;
  limit?: number;
}

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export type ReadToolTruncationDetails = Omit<TruncationResult, "content">;

export type ReadToolDetails =
  | { kind: "text"; content: string }
  | { kind: "image"; content: string; mimeType: string }
  | {
      kind: "truncated";
      content: string;
      truncation: ReadToolTruncationDetails;
    }
  | {
      kind: "not_found";
      status: "not_found";
      path: string;
      optional: true;
    };

export interface WriteToolInput {
  path: string;
  content: string;
}

export type WriteToolDetails =
  | { changed: false }
  | {
      changed: true;
      created: true;
      diff: string;
      patch: string;
      firstChangedLine?: number;
    }
  | {
      changed: true;
      created: false;
      diff: string;
      patch: string;
      firstChangedLine?: number;
    }
  | { changed: true; created?: boolean };
