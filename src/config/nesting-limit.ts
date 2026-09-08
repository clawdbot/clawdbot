/**
 * Nesting depth limits for config JSON to prevent stack overflow.
 *
 * This module provides guards that reject deeply-nested JSON structures before
 * they can cause native stack overflow during parsing or recursive traversal.
 *
 * @see MAX_CONFIG_JSON_NESTING_DEPTH - Maximum allowed nesting depth (512 levels)
 * @see ConfigNestingDepthError - Error thrown when depth limit is exceeded
 */

import { MAX_CONFIG_JSON_NESTING_DEPTH, ConfigNestingDepthError } from "./env-substitution.js";

/**
 * Scans raw JSON/JSON5 text iteratively to measure maximum nesting depth
 * before parsing, rejecting pathological inputs that would overflow the stack.
 *
 * Uses an iterative counter-based approach (not recursion) to safely handle
 * arbitrarily deep structures. Tracks depth through JSON5 comments and strings.
 *
 * @param raw - Raw JSON/JSON5 text to scan
 * @param maxDepth - Maximum allowed depth (default: MAX_CONFIG_JSON_NESTING_DEPTH)
 * @returns The measured maximum nesting depth
 * @throws {ConfigNestingDepthError} If depth exceeds maxDepth
 */
export function assertBoundedRawJsonNesting(
  raw: string,
  maxDepth: number = MAX_CONFIG_JSON_NESTING_DEPTH,
): number {
  let currentDepth = 0;
  let maxDepthReached = 0;
  let inString = false;
  let stringChar: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const prevChar = i > 0 ? raw[i - 1] : null;
    const nextChar = i < raw.length - 1 ? raw[i + 1] : null;

    // Handle escape sequences in strings
    if (inString && char === "\\" && prevChar !== "\\") {
      i++; // Skip escaped character
      continue;
    }

    // Handle string boundaries
    if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }

    // Skip comments (JSON5 feature)
    if (!inString) {
      // Line comment: //
      if (char === "/" && nextChar === "/" && !inLineComment && !inBlockComment) {
        inLineComment = true;
        i++; // Skip second /
        continue;
      }
      // Block comment: /*
      if (char === "/" && nextChar === "*" && !inLineComment && !inBlockComment) {
        inBlockComment = true;
        i++; // Skip *
        continue;
      }
      // End line comment
      if (inLineComment && char === "\n") {
        inLineComment = false;
        continue;
      }
      // End block comment: */
      if (inBlockComment && char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++; // Skip /
        continue;
      }
      // Skip remaining characters inside comments
      if (inLineComment || inBlockComment) {
        continue;
      }
    }

    // Track depth through structural characters
    if (!inString && !inLineComment && !inBlockComment) {
      if (char === "[" || char === "{") {
        currentDepth++;
        maxDepthReached = Math.max(maxDepthReached, currentDepth);
        if (currentDepth > maxDepth) {
          throw new ConfigNestingDepthError(
            currentDepth,
            `raw JSON at character ${i} (line ${raw.slice(0, i).split("\n").length})`,
          );
        }
      } else if (char === "]" || char === "}") {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }
  }

  return maxDepthReached;
}

/**
 * Recursively scans a parsed JSON value to measure its structural nesting depth.
 *
 * @param value - Parsed JSON value to scan
 * @param maxDepth - Maximum allowed depth (default: MAX_CONFIG_JSON_NESTING_DEPTH)
 * @param path - Current path for error reporting (internal use)
 * @param currentDepth - Current depth for recursion (internal use)
 * @returns The measured maximum nesting depth
 * @throws {ConfigNestingDepthError} If depth exceeds maxDepth
 */
export function assertBoundedJsonNesting(
  value: unknown,
  maxDepth: number = MAX_CONFIG_JSON_NESTING_DEPTH,
  path = "",
  currentDepth = 0,
): number {
  if (currentDepth > maxDepth) {
    throw new ConfigNestingDepthError(currentDepth, path || "parsed JSON");
  }

  let maxDepthReached = currentDepth;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const childDepth = assertBoundedJsonNesting(
        value[i],
        maxDepth,
        path ? `${path}[${i}]` : `[${i}]`,
        currentDepth + 1,
      );
      maxDepthReached = Math.max(maxDepthReached, childDepth);
    }
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, val] of Object.entries(value)) {
      const childDepth = assertBoundedJsonNesting(
        val,
        maxDepth,
        path ? `${path}.${key}` : key,
        currentDepth + 1,
      );
      maxDepthReached = Math.max(maxDepthReached, childDepth);
    }
  }

  return maxDepthReached;
}
