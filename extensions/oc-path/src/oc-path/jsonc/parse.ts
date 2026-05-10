import {
  ParseErrorCode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";
import type { Diagnostic } from "../ast.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./ast.js";

export const MAX_PARSE_DEPTH = 256;

/**
 * Hard cap on jsonc input size. `parseTree` is iterative and stack-safe
 * but allocates a tree node per token regardless of depth — a 16 MiB
 * input expanding to millions of nodes hits memory pressure long before
 * `nodeToJsoncValue`'s `MAX_PARSE_DEPTH` walk would notice. Cap at the
 * source level so allocation is bounded by file size, not token count.
 *
 * 16 MiB is well past every workspace-jsonc shape we care about
 * (gateway.jsonc / openclaw.json / .openclaw/* are all <100 KiB in
 * practice; the largest LKG-tracked configs we've seen sit at single-
 * digit MB). Operators with legitimate larger inputs can lift the cap
 * by patching this constant — no SDK affordance because it isn't a
 * supported configuration.
 */
export const MAX_JSONC_INPUT_BYTES = 16 * 1024 * 1024;

export interface JsoncParseResult {
  readonly ast: JsoncAst;
  readonly diagnostics: readonly Diagnostic[];
}

type LineMap = {
  lineForOffset(offset: number): number;
};

type JsoncParserNode = {
  readonly type: "array" | "boolean" | "null" | "number" | "object" | "property" | "string";
  readonly offset: number;
  readonly length: number;
  readonly value?: unknown;
  readonly children?: readonly JsoncParserNode[];
};

export function parseJsonc(raw: string): JsoncParseResult {
  if (raw.trim().length === 0) {
    return { ast: { kind: "jsonc", raw, root: null }, diagnostics: [] };
  }

  // Pre-parse byte-length cap. Symmetric with the post-parse depth cap
  // at `nodeToJsoncValue`. Without this, `parseTree` would allocate the
  // full tree before our walker noticed; bounding at the source keeps
  // memory pressure proportional to input size.
  if (raw.length > MAX_JSONC_INPUT_BYTES) {
    return {
      ast: { kind: "jsonc", raw, root: null },
      diagnostics: [
        {
          line: 1,
          message: `input exceeds MAX_JSONC_INPUT_BYTES (${MAX_JSONC_INPUT_BYTES} bytes; got ${raw.length})`,
          severity: "error",
          code: "OC_JSONC_INPUT_TOO_LARGE",
        },
      ],
    };
  }

  const parseSource = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const errors: ParseError[] = [];
  const tree = parseTree(parseSource, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true,
  }) as JsoncParserNode | undefined;
  const lineMap = createLineMap(raw);
  const diagnostics = errors.map((error) => toDiagnostic(error, lineMap, tree));
  let root: JsoncValue | null = null;
  if (tree && diagnostics.every((d) => d.severity !== "error")) {
    try {
      root = nodeToJsoncValue(tree, lineMap, 0);
    } catch (err) {
      diagnostics.push({
        line: 1,
        message: err instanceof Error ? err.message : String(err),
        severity: "error",
        code: "OC_JSONC_DEPTH_EXCEEDED",
      });
    }
  }

  return {
    ast: {
      kind: "jsonc",
      raw,
      root: diagnostics.every((d) => d.severity !== "error") ? root : null,
    },
    diagnostics,
  };
}

function toDiagnostic(
  error: ParseError,
  lineMap: LineMap,
  tree: JsoncParserNode | undefined,
): Diagnostic {
  const treeEnd = tree ? tree.offset + tree.length : 0;
  const isTrailingInput =
    error.error === ParseErrorCode.EndOfFileExpected ||
    (tree !== undefined && error.error === ParseErrorCode.InvalidSymbol && error.offset >= treeEnd);
  return {
    line: lineMap.lineForOffset(error.offset),
    message: printParseErrorCode(error.error),
    severity: isTrailingInput ? "warning" : "error",
    code: isTrailingInput ? "OC_JSONC_TRAILING_INPUT" : "OC_JSONC_PARSE_FAILED",
  };
}

function nodeToJsoncValue(node: JsoncParserNode, lineMap: LineMap, depth: number): JsoncValue {
  if (depth > MAX_PARSE_DEPTH) {
    throw new Error(`structural depth exceeded MAX_PARSE_DEPTH (${MAX_PARSE_DEPTH})`);
  }
  const line = lineMap.lineForOffset(node.offset);
  switch (node.type) {
    case "object":
      return {
        kind: "object",
        line,
        entries: (node.children ?? []).flatMap((child): JsoncEntry[] => {
          if (child.type !== "property") {
            return [];
          }
          const keyNode = child.children?.[0];
          const valueNode = child.children?.[1];
          if (!keyNode || !valueNode) {
            return [];
          }
          return [
            {
              key: String(keyNode.value),
              line: lineMap.lineForOffset(keyNode.offset),
              value: nodeToJsoncValue(valueNode, lineMap, depth + 1),
            },
          ];
        }),
      };
    case "array":
      return {
        kind: "array",
        line,
        items: (node.children ?? []).map((child) => nodeToJsoncValue(child, lineMap, depth + 1)),
      };
    case "string":
      return { kind: "string", value: String(node.value), line };
    case "number":
      return { kind: "number", value: Number(node.value), line };
    case "boolean":
      return { kind: "boolean", value: Boolean(node.value), line };
    case "null":
      return { kind: "null", line };
    default:
      return { kind: "null", line };
  }
}

function createLineMap(raw: string): LineMap {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return {
    lineForOffset(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const start = starts[mid] ?? 0;
        if (start <= offset) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return Math.max(1, high + 1);
    },
  };
}

export type { Diagnostic };
