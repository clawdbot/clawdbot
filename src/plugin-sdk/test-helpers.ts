import { mkdirSync, writeFileSync, type RmOptions } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export function createPluginSdkTestHarness(options?: { cleanup?: RmOptions }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "openclaw-plugin-sdk-fixtures-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await rm(fixtureRoot, {
      recursive: true,
      force: true,
      ...options?.cleanup,
    });
  });

  function nextTempDir(prefix: string): string {
    return path.join(fixtureRoot, `${prefix}${caseId++}`);
  }

  async function createTempDir(prefix: string): Promise<string> {
    const dir = nextTempDir(prefix);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function createTempDirSync(prefix: string): string {
    const dir = nextTempDir(prefix);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    createTempDir,
    createTempDirSync,
  };
}

export function createBundledPluginPublicSurfaceFixture(params: {
  createTempDirSync: (prefix: string) => string;
  marker: string;
  prefix: string;
}) {
  const rootDir = params.createTempDirSync(params.prefix);
  mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );
  return rootDir;
}

export function createThrowingBundledPluginPublicSurfaceFixture(params: {
  createTempDirSync: (prefix: string) => string;
  prefix: string;
}) {
  const rootDir = params.createTempDirSync(params.prefix);
  mkdirSync(path.join(rootDir, "bad"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "bad", "api.js"),
    `throw new Error("plugin load failure");\n`,
    "utf8",
  );
  return rootDir;
}
