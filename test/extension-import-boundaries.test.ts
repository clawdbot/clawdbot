import { describe, expect, it } from "vitest";
import {
  collectExtensionPluginSdkBoundaryInventory,
  main as extensionPluginSdkMain,
} from "../scripts/check-extension-plugin-sdk-boundary.mjs";
import {
  collectSdkPackageExtensionImportBoundaryInventory,
  main as sdkPackageMain,
} from "../scripts/check-sdk-package-extension-import-boundary.mjs";
import {
  collectSrcExtensionImportBoundaryInventory,
  main as srcExtensionMain,
} from "../scripts/check-src-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const srcInventoryPromise = collectSrcExtensionImportBoundaryInventory();
const srcJsonOutputPromise = getJsonOutput(srcExtensionMain, ["--json"]);
const sdkPackageInventoryPromise = collectSdkPackageExtensionImportBoundaryInventory();
const sdkPackageJsonOutputPromise = getJsonOutput(sdkPackageMain, ["--json"]);
const srcOutsideInventoryPromise =
  collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");
const pluginSdkInternalInventoryPromise =
  collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");
const relativeOutsidePackageInventoryPromise = collectExtensionPluginSdkBoundaryInventory(
  "relative-outside-package",
);
const srcOutsideJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=src-outside-plugin-sdk",
  "--json",
]);
const pluginSdkInternalJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=plugin-sdk-internal",
  "--json",
]);
const relativeOutsidePackageJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=relative-outside-package",
  "--json",
]);

type CapturedIo = ReturnType<typeof createCapturedIo>["io"];

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

describe("src extension import boundary inventory", () => {
  it("stays empty", async () => {
    expect(await srcInventoryPromise).toEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await srcInventoryPromise;
    const second = await collectSrcExtensionImportBoundaryInventory();

    expect(second).toEqual(first);
  });

  it("script json output stays empty", async () => {
    const jsonOutput = await srcJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});

describe("sdk/package extension import boundary inventory", () => {
  it("stays empty", async () => {
    expect(await sdkPackageInventoryPromise).toEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await sdkPackageInventoryPromise;
    const second = await collectSdkPackageExtensionImportBoundaryInventory();

    expect(second).toEqual(first);
  });

  it("script json output stays empty", async () => {
    const jsonOutput = await sdkPackageJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});

describe("extension src outside plugin-sdk boundary inventory", () => {
  it("stays empty and sorted", async () => {
    const inventory = await srcOutsideInventoryPromise;
    const jsonResult = await srcOutsideJsonOutputPromise;

    expect(inventory).toEqual([]);
    expect(
      [...inventory].toSorted(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.resolvedPath.localeCompare(right.resolvedPath) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(inventory);
    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("stays empty", async () => {
    const inventory = await pluginSdkInternalInventoryPromise;
    const jsonResult = await pluginSdkInternalJsonOutputPromise;

    expect(inventory).toEqual([]);
    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});

describe("extension relative-outside-package boundary inventory", () => {
  it("stays empty", async () => {
    const inventory = await relativeOutsidePackageInventoryPromise;
    const jsonResult = await relativeOutsidePackageJsonOutputPromise;

    expect(inventory).toEqual([]);
    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});
