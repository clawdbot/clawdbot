import { describe, expect, it } from "vitest";
import {
  collectWebFetchProviderBoundaryViolations,
  main as webFetchMain,
} from "../scripts/check-web-fetch-provider-boundaries.mjs";
import {
  collectWebSearchProviderBoundaryInventory,
  main as webSearchMain,
} from "../scripts/check-web-search-provider-boundaries.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const webFetchViolationsPromise = collectWebFetchProviderBoundaryViolations();
const webFetchJsonOutputPromise = getJsonOutput(webFetchMain);
const webSearchInventoryPromise = collectWebSearchProviderBoundaryInventory();
const webSearchJsonOutputPromise = getJsonOutput(webSearchMain);

async function getJsonOutput(
  main: (argv: string[], io: ReturnType<typeof createCapturedIo>["io"]) => Promise<number>,
) {
  const captured = createCapturedIo();
  const exitCode = await main(["--json"], captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

describe("web provider boundaries", () => {
  it("keeps Firecrawl-specific fetch logic out of core runtime/tooling", async () => {
    const violations = await webFetchViolationsPromise;
    const jsonOutput = await webFetchJsonOutputPromise;

    expect(violations).toEqual([]);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });

  it("keeps web search provider boundary inventory empty, core-only, and sorted", async () => {
    const inventory = await webSearchInventoryPromise;
    const jsonOutput = await webSearchJsonOutputPromise;

    expect(inventory).toEqual([]);
    expect(
      [...inventory].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(inventory);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});
