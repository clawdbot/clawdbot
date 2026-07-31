/**
 * Contract test for NATIVE_TOOLS_FULL_SET (run-attempt.ts).
 *
 * The list of native tool names we project OpenClaw's policy onto must keep
 * up with @anthropic-ai/claude-agent-sdk. The SDK enumerates each native
 * tool by exporting an `*Input` interface in `sdk-tools.d.ts` (e.g.
 * `BashInput`, `WebFetchInput`, `TodoWriteInput`). This test reads that
 * file, extracts every exported `*Input` interface, normalizes the SDK's
 * naming quirks (e.g. `FileEditInput` → `Edit`), and asserts every one is
 * present in `NATIVE_TOOLS_FULL_SET`.
 *
 * When the SDK adds a new native tool, this test fails until someone:
 *   1. Looks at the new tool, decides whether OpenClaw policy should block
 *      it under `disableTools` / restrictive `toolsAllow`.
 *   2. Adds it to `NATIVE_TOOLS_FULL_SET` (or to `SDK_INPUT_TO_TOOL_NAME`
 *      if the SDK's interface name differs from the runtime tool name).
 *
 * The reverse direction is intentionally not asserted: NATIVE_TOOLS_FULL_SET
 * may include tool names that don't have `*Input` interfaces (e.g.
 * `BashOutput`, `KillBash`, `MultiEdit` are extended SDK tools per the
 * claude_code preset but lack a dedicated typed input shape). Over-blocking
 * is safe; under-blocking is not.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_TOOLS_FULL_SET } from "./run-attempt.js";

// Map from SDK's interface base name (without `Input`) to the runtime tool
// name we ship to `sdkOptions.disallowedTools`. Most are identity; a few
// SDK interfaces use a `File*` prefix that doesn't match the tool name.
const SDK_INPUT_TO_TOOL_NAME: Record<string, string> = {
  FileEdit: "Edit",
  FileRead: "Read",
  FileWrite: "Write",
  // McpInput is a generic dispatch type, not a tool the model invokes.
  Mcp: "__omit__",
};

function findSdkToolsDts(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up to repo root looking for node_modules/@anthropic-ai/claude-agent-sdk.
  let dir = here;
  for (let depth = 0; depth < 10; depth++) {
    const candidate = path.join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk-tools.d.ts",
    );
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // continue walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "could not locate @anthropic-ai/claude-agent-sdk/sdk-tools.d.ts from this test file; " +
      "check that the SDK is installed in node_modules",
  );
}

function extractSdkInputInterfaces(source: string): string[] {
  // Match `export interface <Name>Input` declarations and capture `<Name>`.
  // Use a non-greedy match for safety.
  const matches = source.matchAll(/^export interface ([A-Z][A-Za-z0-9]*)Input\b/gm);
  const names: string[] = [];
  for (const m of matches) {
    const name = m[1];
    if (name) {
      names.push(name);
    }
  }
  return [...new Set(names)].toSorted();
}

function sdkInputToToolName(sdkInterfaceBase: string): string | null {
  const mapped = SDK_INPUT_TO_TOOL_NAME[sdkInterfaceBase];
  if (mapped === "__omit__") {
    return null;
  }
  return mapped ?? sdkInterfaceBase;
}

describe("native-tools coverage vs @anthropic-ai/claude-agent-sdk", () => {
  it("every exported *Input in sdk-tools.d.ts maps to a known native tool", () => {
    const dtsPath = findSdkToolsDts();
    const source = readFileSync(dtsPath, "utf8");
    const sdkInputBases = extractSdkInputInterfaces(source);
    expect(sdkInputBases.length).toBeGreaterThan(0);

    const known = new Set<string>(NATIVE_TOOLS_FULL_SET);
    const missing: string[] = [];
    for (const base of sdkInputBases) {
      const toolName = sdkInputToToolName(base);
      if (toolName === null) {
        continue;
      }
      if (!known.has(toolName)) {
        missing.push(`${base}Input → ${toolName}`);
      }
    }

    expect(
      missing,
      `The SDK exports these *Input types that NATIVE_TOOLS_FULL_SET doesn't cover.\n` +
        `Either add the tool name to NATIVE_TOOLS_FULL_SET, or — if the SDK interface\n` +
        `name differs from the runtime tool name — extend SDK_INPUT_TO_TOOL_NAME in\n` +
        `this test file:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
