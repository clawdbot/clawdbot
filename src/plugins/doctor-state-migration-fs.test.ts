import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveLegacyStateSource } from "./doctor-state-migration-fs.js";

describe("archiveLegacyStateSource", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-fs-")));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("archives a source without an existing archive", async () => {
    const filePath = path.join(dir, "state.json");
    await fs.writeFile(filePath, "{}");
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(warnings).toEqual([]);
    expect(changes).toEqual([`Archived test state legacy source -> ${filePath}.migrated`]);
    await expect(fs.readFile(`${filePath}.migrated`, "utf8")).resolves.toBe("{}");
  });

  it("removes the source when an identical archive already exists", async () => {
    const filePath = path.join(dir, "state.json");
    await fs.writeFile(filePath, "{}");
    await fs.writeFile(`${filePath}.migrated`, "{}");
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(warnings).toEqual([]);
    expect(changes).toEqual([`Removed already-archived test state legacy source ${filePath}`]);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("archives under a free suffix when a differing archive already exists", async () => {
    const filePath = path.join(dir, "state.json");
    await fs.writeFile(filePath, `{"newer":true}`);
    await fs.writeFile(`${filePath}.migrated`, "{}");
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(warnings).toEqual([]);
    expect(changes).toEqual([`Archived test state legacy source -> ${filePath}.migrated.2`]);
    await expect(fs.readFile(`${filePath}.migrated.2`, "utf8")).resolves.toBe(`{"newer":true}`);
    await expect(fs.readFile(`${filePath}.migrated`, "utf8")).resolves.toBe("{}");
  });

  it.runIf(process.platform !== "win32")(
    "removes the source when an identical archive is a symlink",
    async () => {
      const filePath = path.join(dir, "state.json");
      const archiveTarget = path.join(dir, "archive-target.json");
      await fs.writeFile(filePath, "{}");
      await fs.writeFile(archiveTarget, "{}");
      await fs.symlink(archiveTarget, `${filePath}.migrated`);
      const changes: string[] = [];
      const warnings: string[] = [];

      await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

      expect(warnings).toEqual([]);
      expect(changes).toEqual([`Removed already-archived test state legacy source ${filePath}`]);
      await expect(fs.stat(filePath)).rejects.toThrow();
      await expect(fs.readFile(`${filePath}.migrated`, "utf8")).resolves.toBe("{}");
      await expect(fs.lstat(`${filePath}.migrated`)).resolves.toSatisfy((stat) =>
        stat.isSymbolicLink(),
      );
    },
  );

  it("archives under a free suffix without reading an oversized existing archive", async () => {
    const filePath = path.join(dir, "state.json");
    await fs.writeFile(filePath, `{"newer":true}`);
    await fs.writeFile(`${filePath}.migrated`, Buffer.alloc(64 * 1024 * 1024 + 1));
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(warnings).toEqual([]);
    expect(changes).toEqual([`Archived test state legacy source -> ${filePath}.migrated.2`]);
    await expect(fs.readFile(`${filePath}.migrated.2`, "utf8")).resolves.toBe(`{"newer":true}`);
  });

  it("removes the source when an identical archive exceeds the comparison chunk", async () => {
    const filePath = path.join(dir, "state.json");
    const archivePath = `${filePath}.migrated`;
    const size = 64 * 1024 * 1024 + 1;
    await fs.writeFile(filePath, "");
    await fs.writeFile(archivePath, "");
    await Promise.all([fs.truncate(filePath, size), fs.truncate(archivePath, size)]);
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(warnings).toEqual([]);
    expect(changes).toEqual([`Removed already-archived test state legacy source ${filePath}`]);
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.stat(archivePath)).resolves.toMatchObject({ size });
  });

  it("keeps a failed archive as a warning", async () => {
    const filePath = path.join(dir, "missing.json");
    const changes: string[] = [];
    const warnings: string[] = [];

    await archiveLegacyStateSource({ filePath, label: "test state", changes, warnings });

    expect(changes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed archiving test state legacy source");
  });
});
