import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listMemoryFiles,
  readMemoryFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMemoryPathClassification } from "./memory/memory-path-provenance.js";

describe.skipIf(process.platform !== "win32")("Windows explicit memory extra-file casing", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let physicalPath = "";
  let configuredAlias = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-extra-file-case-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    physicalPath = path.join(fixtureRoot, "shared-notes.md");
    configuredAlias = path.join(fixtureRoot, "SHARED-NOTES.MD");
    await fs.writeFile(physicalPath, "shared Windows memory", "utf8");

    const [physicalStat, aliasStat] = await Promise.all([
      fs.stat(physicalPath),
      fs.stat(configuredAlias),
    ]);
    expect({ dev: aliasStat.dev, ino: aliasStat.ino }).toEqual({
      dev: physicalStat.dev,
      ino: physicalStat.ino,
    });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(["physical", "alias"] as const)(
    "lists and reads the configured %s spelling",
    async (spelling) => {
      const configuredPath = spelling === "physical" ? physicalPath : configuredAlias;
      await expect(listMemoryFiles(workspaceDir, [configuredPath])).resolves.toEqual([
        configuredPath,
      ]);
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [configuredPath],
          relPath: configuredPath,
        }),
      ).resolves.toMatchObject({ text: "shared Windows memory" });
    },
  );

  it("keeps the external file untrusted and built-in discovery case-exact", async () => {
    await expect(
      resolveMemoryPathClassification({
        absolutePath: configuredAlias,
        source: "memory",
        workspaceDir,
      }),
    ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });

    const canonicalRoot = path.join(workspaceDir, "MEMORY.md");
    const uppercaseBuiltIn = path.join(workspaceDir, "memory", "BUILTIN.MD");
    await fs.writeFile(canonicalRoot, "canonical", "utf8");
    await fs.writeFile(uppercaseBuiltIn, "excluded built-in alias", "utf8");
    await expect(listMemoryFiles(workspaceDir)).resolves.toEqual([canonicalRoot]);
  });
});
