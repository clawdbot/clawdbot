// SubCLI descriptor tests cover metadata for registered nested command groups.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

async function importSubCliDescriptors() {
  vi.resetModules();
  return import("./subcli-descriptors.js");
}

function descriptorNames(descriptors: ReadonlyArray<{ name: string }>): string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

describe("sub-cli descriptors", () => {
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  afterEach(() => {
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
    vi.resetModules();
  });

  it("cold-imports without an ESM initialization cycle", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          "await import('./src/cli/program/subcli-descriptors.ts')",
        ],
        { cwd: process.cwd(), timeout: 30_000 },
      ),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("keeps the exported descriptor list aligned with private QA visibility when disabled (#83927)", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const { SUB_CLI_DESCRIPTORS, getSubCliEntriesCore } = await importSubCliDescriptors();
    const exportedNames = descriptorNames(SUB_CLI_DESCRIPTORS);

    expect(exportedNames).toEqual(descriptorNames(getSubCliEntriesCore()));
    expect(exportedNames).not.toContain("qa");
  });

  it("keeps all sub-cli filter surfaces aligned when private QA is disabled (#83926)", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const {
      SUB_CLI_DESCRIPTORS,
      getSubCliCommandsWithSubcommands,
      getSubCliParentDefaultHelpCommands,
    } = await importSubCliDescriptors();
    const exportedNames = descriptorNames(SUB_CLI_DESCRIPTORS);

    expect(exportedNames).not.toContain("qa");
    expect(getSubCliCommandsWithSubcommands()).not.toContain("qa");
    expect(getSubCliParentDefaultHelpCommands()).not.toContain("qa");
  });

  it("includes qa in the exported descriptor list when private QA is enabled", async () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";

    const {
      SUB_CLI_DESCRIPTORS,
      getSubCliCommandsWithSubcommands,
      getSubCliEntriesCore,
      getSubCliParentDefaultHelpCommands,
    } = await importSubCliDescriptors();
    const exportedNames = descriptorNames(SUB_CLI_DESCRIPTORS);

    expect(exportedNames).toEqual(descriptorNames(getSubCliEntriesCore()));
    expect(exportedNames).toContain("qa");
    expect(getSubCliCommandsWithSubcommands()).toContain("qa");
    expect(getSubCliParentDefaultHelpCommands()).not.toContain("qa");
  });
});
