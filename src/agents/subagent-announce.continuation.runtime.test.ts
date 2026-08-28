/**
 * Scenario: continuation runtime packaging + announce-host boundary.
 *
 * Covers:
 * - tsdown main-graph entry for `subagent-announce.continuation.runtime`
 * - real coordinator/return-router exports (not a facade)
 * - announce host stays a thin lazy-loader into the coordinator
 *
 * Stubs: none. This is source/export inspection only. After the
 * `src/agents/*` → `src/agents/subagents/announce/*` move, the host lives at
 * `subagents/announce/subagent-announce.ts` and calls the coordinator through
 * `loadSubagentContinuationRuntime`. The lazy import itself lives on
 * `subagent-announce-deps.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";
import * as continuationRuntime from "./subagent-announce.continuation.runtime.js";

const ANNOUNCE_HOST_PATH = "src/agents/subagents/announce/subagent-announce.ts";
const ANNOUNCE_LAZY_LOADER_PATH = "src/agents/subagents/announce/subagent-announce-deps.ts";
const CONTINUATION_RUNTIME_PATH = "src/agents/subagent-announce.continuation.runtime.ts";
const CONTINUATION_RUNTIME_LAZY_IMPORT =
  'import("../../subagent-announce.continuation.runtime.js")';

type TsdownConfigEntry = {
  entry?: Record<string, string> | string[];
};

function entriesOfMainGraph(): Record<string, string> {
  const configs = Array.isArray(tsdownConfig) ? tsdownConfig : [tsdownConfig];
  const main = (configs as TsdownConfigEntry[]).find((config) => {
    const entry = config.entry;
    return Boolean(entry && !Array.isArray(entry) && "subagent-registry.runtime" in entry);
  });
  if (!main?.entry || Array.isArray(main.entry)) {
    throw new Error("could not locate main dist graph in tsdown config");
  }
  return main.entry;
}

describe("subagent-announce continuation runtime entry", () => {
  it("registers the continuation runtime as a tsdown bundler entry", () => {
    expect(entriesOfMainGraph()["subagent-announce.continuation.runtime"]).toBe(
      CONTINUATION_RUNTIME_PATH,
    );
  });

  it("exports the real continuation coordinator and return router", () => {
    expect(typeof continuationRuntime.coordinateSubagentContinuation).toBe("function");
    expect(typeof continuationRuntime.routeSubagentContinuationReturn).toBe("function");
  });

  it("keeps the upstream announce host bounded to coordinator calls", () => {
    const loader = readFileSync(resolve(process.cwd(), ANNOUNCE_LAZY_LOADER_PATH), "utf8");
    const source = readFileSync(resolve(process.cwd(), ANNOUNCE_HOST_PATH), "utf8");
    expect(loader).toContain(CONTINUATION_RUNTIME_LAZY_IMPORT);
    expect(source).toContain("coordinateSubagentContinuation");
    expect(source).toContain("routeSubagentContinuationReturn");
    expect(source).not.toContain("../auto-reply/continuation/delegate-dispatch.js");
    expect(source).not.toContain("function drainChildContinuationQueue");
  });

  it("is not a re-export facade", () => {
    const source = readFileSync(resolve(process.cwd(), CONTINUATION_RUNTIME_PATH), "utf8");
    expect(source).toContain("export async function coordinateSubagentContinuation");
    expect(source).toContain("./subagent-announce.continuation.accounting.js");
    expect(source).toContain("./subagent-announce.continuation-return.js");
  });
});
