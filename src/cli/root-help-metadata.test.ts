// Precomputed help preserves field selection, snapshots, and stdout semantics.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { readMetadata, write } = vi.hoisted(() => ({
  readMetadata: vi.fn(),
  write: vi.fn<typeof process.stdout.write>(),
}));
vi.mock("./startup-metadata.js", () => ({ readCliStartupMetadata: readMetadata }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadata = {
  rootHelpText: " root \n",
  browserHelpText: " browser \n",
  secretsHelpText: " secrets \n",
  nodesHelpText: " nodes \n",
  config: "not nested config",
  subcommandHelpText: {
    rootHelpText: "not flat root",
    config: " config \n",
    doctor: " doctor \n",
    gateway: " gateway \n",
    models: " models \n",
    plugins: " plugins \n",
    sessions: " sessions \n",
    tasks: " tasks \n",
  },
};
let help: typeof import("./root-help-metadata.js");

beforeEach(async () => {
  vi.resetModules();
  readMetadata.mockReset().mockReturnValue(metadata);
  write.mockReset().mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockImplementation(write);
  help = await import("./root-help-metadata.js");
});
afterEach(() => vi.restoreAllMocks());

describe("precomputed help metadata output", () => {
  it.each([
    ["outputPrecomputedRootHelpText", " root \n"],
    ["outputPrecomputedBrowserHelpText", " browser \n"],
    ["outputPrecomputedSecretsHelpText", " secrets \n"],
    ["outputPrecomputedNodesHelpText", " nodes \n"],
  ] as const)("preserves %s bytes", (name, text) => {
    expect(help[name]()).toBe(true);
    expect(write.mock.calls).toEqual([[text]]);
  });

  it.each([
    ["config", " config \n"],
    ["doctor", " doctor \n"],
    ["gateway", " gateway \n"],
    ["models", " models \n"],
    ["plugins", " plugins \n"],
    ["sessions", " sessions \n"],
    ["tasks", " tasks \n"],
  ] as const)("preserves nested %s bytes", (name, text) => {
    expect(help.outputPrecomputedSubcommandHelpText(name)).toBe(true);
    expect(write.mock.calls).toEqual([[text]]);
  });

  it("keeps successful flat and nested field snapshots independent", () => {
    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(true);
    readMetadata.mockReturnValue(null);
    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(true);
    expect(write.mock.calls).toEqual([[" root \n"], [" config \n"], [" root \n"], [" config \n"]]);
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, "", 17, {}])("rejects non-text fields (%j)", (value) => {
    readMetadata.mockReturnValue({
      rootHelpText: value,
      subcommandHelpText: { config: value },
    });
    expect(help.outputPrecomputedRootHelpText()).toBe(false);
    expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps cached misses independent from a previously unread field", () => {
    readMetadata.mockReturnValue(null);
    expect(help.outputPrecomputedRootHelpText()).toBe(false);
    expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(false);
    readMetadata.mockReturnValue(metadata);
    expect(help.outputPrecomputedRootHelpText()).toBe(false);
    expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(help.outputPrecomputedBrowserHelpText()).toBe(true);
    expect(write.mock.calls).toEqual([[" browser \n"]]);
    expect(readMetadata).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, "config", 17])(
    "rejects a non-object nested container (%j)",
    (value) => {
      readMetadata.mockReturnValue({ config: "not nested config", subcommandHelpText: value });
      expect(help.outputPrecomputedSubcommandHelpText("config")).toBe(false);
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported names before metadata reads or output", () => {
    for (const name of ["browser", "rootHelpText", "status"]) {
      expect(help.outputPrecomputedSubcommandHelpText(name)).toBe(false);
    }
    expect(readMetadata).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("retains a help miss when the real reader advances from null to parent metadata", async () => {
    const parentDir = tempDirs.make("openclaw-help-metadata-");
    const moduleDir = path.join(parentDir, "chunks");
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(path.join(moduleDir, "cli-startup-metadata.json"), "null");
    fs.writeFileSync(
      path.join(parentDir, "cli-startup-metadata.json"),
      JSON.stringify({ browserHelpText: " parent browser \n" }),
    );
    const moduleUrl = pathToFileURL(path.join(moduleDir, "root-help-metadata.js")).href;
    const { readCliStartupMetadata } =
      await vi.importActual<typeof import("./startup-metadata.js")>("./startup-metadata.js");
    readMetadata.mockImplementation(() => readCliStartupMetadata(moduleUrl));

    expect(help.outputPrecomputedBrowserHelpText()).toBe(false);
    expect(readCliStartupMetadata(moduleUrl)).toEqual({ browserHelpText: " parent browser \n" });
    expect(help.outputPrecomputedBrowserHelpText()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(readMetadata).toHaveBeenCalledOnce();
  });

  it("populates the cache before a failed write and treats backpressure as handled", () => {
    const failure = new Error("stdout failed");
    write
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(false);
    expect(() => help.outputPrecomputedRootHelpText()).toThrow(failure);
    readMetadata.mockReturnValue(null);
    expect(help.outputPrecomputedRootHelpText()).toBe(true);
    expect(write.mock.calls).toEqual([[" root \n"], [" root \n"]]);
    expect(readMetadata).toHaveBeenCalledOnce();
  });
});
