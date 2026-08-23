// Web provider boundary tests enforce provider import boundaries.
import { describe, expect, it } from "vitest";
import { main as webFetchMain } from "../scripts/check-web-fetch-provider-boundaries.mts";
import { main as webSearchMain } from "../scripts/check-web-search-provider-boundaries.mts";
import { createCapturedIo } from "./helpers/captured-io.js";

const webFetchJsonOutputPromise = getJsonOutput(webFetchMain);
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
  it("runs the web fetch boundary script in JSON mode", async () => {
    const jsonOutput = await webFetchJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toStrictEqual([]);
  });

  it("runs the web search boundary script in JSON mode", async () => {
    const jsonOutput = await webSearchJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toStrictEqual([]);
  });
});
