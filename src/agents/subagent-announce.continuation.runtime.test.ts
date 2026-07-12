// Regression coverage for the continuation runtime entry:
// `subagent-announce.ts` lazy-loads the continuation drain via
// `importRuntimeModule(import.meta.url, [...])`. That dynamic import path
// is NOT bundler-rewritten; the bundler emits the source modules into a
// flat hashed dist layout and the lazy import resolves against the dist
// file's own URL. Pre-fix, the import targeted
// `../auto-reply/continuation/delegate-dispatch.js` which does not
// exist post-bundle, producing `ERR_MODULE_NOT_FOUND` at runtime.
//
// Fix shape (mirrors `subagent-registry.runtime.ts`):
//   1. Co-located runtime entry `subagent-announce.continuation.runtime.ts`
//      that re-exports the lazy drain symbols.
//   2. Registered as a tsdown bundler entry so it lands at a stable on-disk
//      path post-bundle.
//   3. `subagent-announce.ts` lazy-imports against `["./subagent-announce.continuation.runtime", ".js"]`
//      which resolves cleanly against the same dist directory.
//
// These tests assert the contract of the fix so a refactor that drops the
// runtime entry, the bundler registration, or the symbol re-exports fails
// loudly instead of silently regressing to `ERR_MODULE_NOT_FOUND` in
// production.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";
import * as continuationRuntime from "./subagent-announce.continuation.runtime.js";

type TsdownConfigEntry = {
  entry?: Record<string, string> | string[];
};

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entriesOfMainGraph(): Record<string, string> {
  const configs = asConfigArray(tsdownConfig);
  const main = configs.find((c) => {
    const entry = c.entry;
    if (!entry || Array.isArray(entry)) {
      return false;
    }
    return Object.keys(entry).includes("subagent-registry.runtime");
  });
  if (!main || !main.entry || Array.isArray(main.entry)) {
    throw new Error("could not locate main dist graph in tsdown config");
  }
  return main.entry;
}

describe("subagent-announce continuation runtime entry", () => {
  it("registers the continuation runtime as a tsdown bundler entry", () => {
    const entries = entriesOfMainGraph();
    expect(entries).toHaveProperty("subagent-announce.continuation.runtime");
    expect(entries["subagent-announce.continuation.runtime"]).toBe(
      "src/agents/subagent-announce.continuation.runtime.ts",
    );
  });

  it("exports dispatchToolDelegates from the continuation runtime", () => {
    expect(typeof continuationRuntime.dispatchToolDelegates).toBe("function");
  });

  it("exports loadContinuationChainState from the continuation runtime", () => {
    expect(typeof continuationRuntime.loadContinuationChainState).toBe("function");
  });

  it("exports persistContinuationChainState from the continuation runtime", () => {
    expect(typeof continuationRuntime.persistContinuationChainState).toBe("function");
  });

  it("exports updateSessionEntry from the continuation runtime", () => {
    expect(typeof continuationRuntime.updateSessionEntry).toBe("function");
  });

  it("exports resolveStorePath from the continuation runtime", () => {
    expect(typeof continuationRuntime.resolveStorePath).toBe("function");
  });

  it("exports resolveAgentIdFromSessionKey from the continuation runtime", () => {
    expect(typeof continuationRuntime.resolveAgentIdFromSessionKey).toBe("function");
  });

  it("exports every symbol destructured by subagent-announce runtime imports", () => {
    // Per-symbol assertions above pin individual exports. This test pins the
    // FULL set in one place so a refactor that adds a new destructured symbol
    // to subagent-announce.ts (without adding the corresponding export here)
    // is caught loudly.
    //
    // The set MUST match every key in subagent-announce.ts's three module-shape
    // type declarations (ContinuationDispatchModule + ContinuationStateModule +
    // SessionStoreUpdateModule, lines 176-217 on v5.2 canonical bac4caceac).
    const requiredExports = [
      // ContinuationDispatchModule
      "dispatchToolDelegates",
      // ContinuationStateModule
      "loadContinuationChainState",
      "persistContinuationChainState",
      // SessionStoreUpdateModule
      "updateSessionEntry",
      "resolveStorePath",
      "resolveAgentIdFromSessionKey",
    ] as const;

    for (const exportName of requiredExports) {
      expect(
        (continuationRuntime as Record<string, unknown>)[exportName],
        `runtime entry MUST export ${exportName} (subagent-announce.ts destructures it via importRuntimeModule)`,
      ).toBeDefined();
      expect(
        typeof (continuationRuntime as Record<string, unknown>)[exportName],
        `runtime entry export ${exportName} MUST be a function`,
      ).toBe("function");
    }
  });

  it("subagent-announce.ts destructures EVERY runtime export via the canonical entry path", () => {
    // Guards against drift where subagent-announce.ts adds a new module-shape
    // type but the destructure points at a source-tree path instead of the
    // co-located runtime entry. All three module-shape importRuntimeModule
    // calls MUST resolve against "./subagent-announce.continuation.runtime".
    const announceSrc = readFileSync(
      resolve(process.cwd(), "src/agents/subagent-announce.ts"),
      "utf8",
    );

    // Count importRuntimeModule calls; each must use the runtime-entry path.
    const importCalls = announceSrc.match(/importRuntimeModule</g) ?? [];
    expect(importCalls.length).toBeGreaterThanOrEqual(3); // dispatch + state + session-store

    const runtimeEntryRefs =
      announceSrc.match(/["']\.\/subagent-announce\.continuation\.runtime["']/g) ?? [];
    expect(runtimeEntryRefs.length).toBe(importCalls.length);
  });

  it("subagent-announce lazy-imports the runtime entry by its co-located path, not the source-tree path", () => {
    // Post-bundle, the dist emits `subagent-announce.continuation.runtime.js`
    // adjacent to the bundled subagent-announce code. The pre-fix path
    // (`../auto-reply/continuation/delegate-dispatch.js`) does not exist
    // post-bundle and would resolve to a non-existent nested path.
    const announceSrc = readFileSync(
      resolve(process.cwd(), "src/agents/subagent-announce.ts"),
      "utf8",
    );
    expect(announceSrc).toContain('"./subagent-announce.continuation.runtime"');
    expect(announceSrc).not.toContain('"../auto-reply/continuation/delegate-dispatch.js"');
    expect(announceSrc).not.toContain('"../auto-reply/continuation/config.js"');
  });
});
