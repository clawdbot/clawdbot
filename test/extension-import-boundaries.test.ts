import { describe, expect, it } from "vitest";
import { main as extensionPluginSdkMain } from "../scripts/check-extension-plugin-sdk-boundary.mjs";
import { main as sdkPackageMain } from "../scripts/check-sdk-package-extension-import-boundary.mjs";
import { main as srcExtensionMain } from "../scripts/check-src-extension-import-boundary.mjs";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

type CapturedIo = ReturnType<typeof createCapturedIo>["io"];
type JsonOutputPromise = ReturnType<typeof getJsonOutput>;

const boundaryInventoryCases: Array<{
  name: string;
  output: JsonOutputPromise;
}> = [
  {
    name: "src extension import boundary",
    output: getJsonOutput(srcExtensionMain, ["--json"]),
  },
  {
    name: "sdk/package extension import boundary",
    output: getJsonOutput(sdkPackageMain, ["--json"]),
  },
  {
    name: "extension src outside plugin-sdk boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=src-outside-plugin-sdk", "--json"]),
  },
  {
    name: "extension plugin-sdk-internal boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=plugin-sdk-internal", "--json"]),
  },
  {
    name: "extension relative-outside-package boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=relative-outside-package", "--json"]),
  },
];

describe("fast module reference scanner", () => {
  it("collects code references without matching comments or strings", () => {
    expect(
      collectModuleReferencesFromSource(`
// import "./commented";
const text = 'import("./string")';
import "./side-effect";
import type { Example } from "./types";
export { Example } from "./public";
await import("./runtime");
`),
    ).toEqual([
      { kind: "import", line: 4, specifier: "./side-effect" },
      { kind: "import", line: 5, specifier: "./types" },
      { kind: "export", line: 6, specifier: "./public" },
      { kind: "dynamic-import", line: 7, specifier: "./runtime" },
    ]);
  });
});

describe("extension import boundary inventories", () => {
  it.each(boundaryInventoryCases)("$name JSON output stays empty", async ({ output }) => {
    const jsonOutput = await output;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toStrictEqual([]);
  });
});

async function getJsonOutput(
  main: (argv: string[], io: CapturedIo) => Promise<number>,
  argv: string[],
) {
  const captured = createCapturedIo();
  const exitCode = await main(argv, captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}
