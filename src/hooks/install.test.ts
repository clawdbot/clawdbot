import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectSingleNpmPackIgnoreScriptsCall } from "../test-utils/exec-assertions.js";
import {
  expectInstallUsesIgnoreScripts,
  expectIntegrityDriftRejected,
  expectUnsupportedNpmSpec,
  mockNpmPackMetadataResult,
} from "../test-utils/npm-spec-install-test-helpers.js";
import { isAddressInUseError } from "./gmail-watcher-errors.js";

type InstallHooksFromArchive = typeof import("./install.js").installHooksFromArchive;
type InstallHooksFromPath = typeof import("./install.js").installHooksFromPath;

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.resetModules();

const { installHooksFromArchive, installHooksFromNpmSpec, installHooksFromPath } =
  await import("./install.js");
const hookInstallRuntime = await import("./install.runtime.js");

const fixtureRoot = path.join(process.cwd(), ".tmp", `openclaw-hook-install-${randomUUID()}`);
const sharedArchiveDir = path.join(fixtureRoot, "_archives");
let tempDirIndex = 0;
const sharedArchivePathByName = new Map<string, string>();

const fixturesDir = path.resolve(process.cwd(), "test", "fixtures", "hooks-install");
const zipHooksBuffer = fs.readFileSync(path.join(fixturesDir, "zip-hooks.zip"));
const zipTraversalBuffer = fs.readFileSync(path.join(fixturesDir, "zip-traversal.zip"));
const tarHooksBuffer = fs.readFileSync(path.join(fixturesDir, "tar-hooks.tar"));
const tarTraversalBuffer = fs.readFileSync(path.join(fixturesDir, "tar-traversal.tar"));
const tarEvilIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-evil-id.tar"));
const tarReservedIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-reserved-id.tar"));
const npmPackHooksBuffer = fs.readFileSync(path.join(fixturesDir, "npm-pack-hooks.tgz"));

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir);
  return dir;
}

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

beforeAll(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(sharedArchiveDir, { recursive: true });
});

function writeArchiveFixture(params: { fileName: string; contents: Buffer }) {
  const stateDir = makeTempDir();
  const archiveHash = createHash("sha256").update(params.contents).digest("hex").slice(0, 12);
  const archiveKey = `${params.fileName}:${archiveHash}`;
  let archivePath = sharedArchivePathByName.get(archiveKey);
  if (!archivePath) {
    archivePath = path.join(sharedArchiveDir, `${archiveHash}-${params.fileName}`);
    fs.writeFileSync(archivePath, params.contents);
    sharedArchivePathByName.set(archiveKey, archivePath);
  }
  return {
    stateDir,
    archivePath,
    hooksDir: path.join(stateDir, "hooks"),
  };
}

function expectInstallFailureContains(
  result: Awaited<ReturnType<InstallHooksFromArchive>>,
  snippets: string[],
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  for (const snippet of snippets) {
    expect(result.error).toContain(snippet);
  }
}

function writeHookPackManifest(params: {
  pkgDir: string;
  hooks: string[];
  dependencies?: Record<string, string>;
}) {
  fs.writeFileSync(
    path.join(params.pkgDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      openclaw: { hooks: params.hooks },
      ...(params.dependencies ? { dependencies: params.dependencies } : {}),
    }),
    "utf-8",
  );
}

async function installArchiveFixture(params: { fileName: string; contents: Buffer }) {
  const fixture = writeArchiveFixture(params);
  const result = await installHooksFromArchive({
    archivePath: fixture.archivePath,
    hooksDir: fixture.hooksDir,
  });
  return { fixture, result };
}

function expectPathInstallFailureContains(
  result: Awaited<ReturnType<InstallHooksFromPath>>,
  snippet: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected install failure");
  }
  expect(result.error).toContain(snippet);
}

describe("installHooksFromArchive", () => {
  it.each([
    {
      name: "zip",
      fileName: "hooks.zip",
      contents: zipHooksBuffer,
      expectedPackId: "zip-hooks",
      expectedHook: "zip-hook",
    },
    {
      name: "tar",
      fileName: "hooks.tar",
      contents: tarHooksBuffer,
      expectedPackId: "tar-hooks",
      expectedHook: "tar-hook",
    },
  ])("installs hook packs from $name archives", async (tc) => {
    const { fixture, result } = await installArchiveFixture({
      fileName: tc.fileName,
      contents: tc.contents,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe(tc.expectedPackId);
    expect(result.hooks).toContain(tc.expectedHook);
    expect(result.targetDir).toBe(path.join(fixture.stateDir, "hooks", tc.expectedPackId));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", tc.expectedHook, "HOOK.md"))).toBe(
      true,
    );
  });

  it.each([
    {
      name: "zip",
      fileName: "traversal.zip",
      contents: zipTraversalBuffer,
      expectedDetail: "archive entry",
    },
    {
      name: "tar",
      fileName: "traversal.tar",
      contents: tarTraversalBuffer,
      expectedDetail: "escapes destination",
    },
  ])("rejects $name archives with traversal entries", async (tc) => {
    const { result } = await installArchiveFixture({
      fileName: tc.fileName,
      contents: tc.contents,
    });
    expectInstallFailureContains(result, ["failed to extract archive", tc.expectedDetail]);
  });

  it.each([
    {
      name: "traversal-like ids",
      contents: tarEvilIdBuffer,
    },
    {
      name: "reserved ids",
      contents: tarReservedIdBuffer,
    },
  ])("rejects hook packs with $name", async (tc) => {
    const { result } = await installArchiveFixture({
      fileName: "hooks.tar",
      contents: tc.contents,
    });
    expectInstallFailureContains(result, ["reserved path segment"]);
  });
});

describe("installHooksFromPath", () => {
  it("uses --ignore-scripts for dependency install", async () => {
    const workDir = makeTempDir();
    const stateDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", "one-hook"), { recursive: true });
    writeHookPackManifest({
      pkgDir,
      hooks: ["./hooks/one-hook"],
      dependencies: { "left-pad": "1.3.0" },
    });
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "HOOK.md"),
      [
        "---",
        "name: one-hook",
        "description: One hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# One Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );

    const run = runCommandWithTimeoutMock;
    await expectInstallUsesIgnoreScripts({
      run,
      install: async () =>
        await installHooksFromPath({
          path: pkgDir,
          hooksDir: path.join(stateDir, "hooks"),
        }),
    });
  });

  it("installs a single hook directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: my-hook",
        "description: My hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# My Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("my-hook");
    expect(result.hooks).toEqual(["my-hook"]);
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "my-hook"));
    expect(fs.existsSync(path.join(result.targetDir, "HOOK.md"))).toBe(true);
  });

  it("rejects out-of-package hook entries", async () => {
    const cases = [
      {
        hooks: ["../outside"],
        setupLink: false,
        expected: "openclaw.hooks entry escapes package directory",
      },
      {
        hooks: ["./linked"],
        setupLink: true,
        expected: "openclaw.hooks entry resolves outside package directory",
      },
    ] as const;

    for (const testCase of cases) {
      const stateDir = makeTempDir();
      const workDir = makeTempDir();
      const pkgDir = path.join(workDir, "package");
      const outsideHookDir = path.join(workDir, "outside");
      const linkedDir = path.join(pkgDir, "linked");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.mkdirSync(outsideHookDir, { recursive: true });
      fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n", "utf-8");
      fs.writeFileSync(
        path.join(outsideHookDir, "handler.ts"),
        "export default async () => {};\n",
        "utf-8",
      );
      if (testCase.setupLink) {
        try {
          fs.symlinkSync(
            outsideHookDir,
            linkedDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch {
          continue;
        }
      }
      writeHookPackManifest({
        pkgDir,
        hooks: [...testCase.hooks],
      });

      const result = await installHooksFromPath({
        path: pkgDir,
        hooksDir: path.join(stateDir, "hooks"),
      });

      expectPathInstallFailureContains(result, testCase.expected);
    }
  });
});

describe("installHooksFromNpmSpec", () => {
  it("does not expose dangerous force unsafe install through npm-spec archive params", async () => {
    const installFromValidatedNpmSpecArchiveSpy = vi
      .spyOn(hookInstallRuntime, "installFromValidatedNpmSpecArchive")
      .mockImplementation(
        async (
          params: Parameters<typeof hookInstallRuntime.installFromValidatedNpmSpecArchive>[0],
        ) => {
          expect(
            (params.archiveInstallParams as Record<string, unknown>).dangerouslyForceUnsafeInstall,
          ).toBeUndefined();
          return {
            ok: true,
            hookPackId: "test-hooks",
            hooks: ["one-hook"],
            targetDir: "/tmp/hooks/test-hooks",
            version: "0.0.1",
          };
        },
      );

    try {
      const result = await installHooksFromNpmSpec({
        spec: "@openclaw/test-hooks@0.0.1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.hookPackId).toBe("test-hooks");
    } finally {
      installFromValidatedNpmSpecArchiveSpy.mockRestore();
    }
  });

  it("uses --ignore-scripts for npm pack and cleans up temp dir", async () => {
    const stateDir = makeTempDir();

    const run = runCommandWithTimeoutMock;
    let packTmpDir = "";
    const packedName = "test-hooks-0.0.1.tgz";
    run.mockImplementation(async (argv, opts) => {
      if (argv[0] === "npm" && argv[1] === "pack") {
        packTmpDir = typeof opts === "number" ? "" : (opts.cwd ?? "");
        fs.writeFileSync(path.join(packTmpDir, packedName), npmPackHooksBuffer);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "@openclaw/test-hooks@0.0.1",
              name: "@openclaw/test-hooks",
              version: "0.0.1",
              filename: packedName,
              integrity: "sha512-hook-test",
              shasum: "hookshasum",
            },
          ]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      hooksDir,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("test-hooks");
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/test-hooks@0.0.1");
    expect(result.npmResolution?.integrity).toBe("sha512-hook-test");
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);

    expectSingleNpmPackIgnoreScriptsCall({
      calls: run.mock.calls as Array<[unknown, unknown]>,
      expectedSpec: "@openclaw/test-hooks@0.0.1",
    });

    expect(packTmpDir).not.toBe("");
    expect(fs.existsSync(packTmpDir)).toBe(false);
  });

  it("aborts when integrity drift callback rejects the fetched artifact", async () => {
    const run = runCommandWithTimeoutMock;
    mockNpmPackMetadataResult(run, {
      id: "@openclaw/test-hooks@0.0.1",
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      filename: "test-hooks-0.0.1.tgz",
      integrity: "sha512-new",
      shasum: "newshasum",
    });

    const onIntegrityDrift = vi.fn(async () => false);
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
    });
    expectIntegrityDriftRejected({
      onIntegrityDrift,
      result,
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
  });

  it("rejects invalid npm spec shapes", async () => {
    await expectUnsupportedNpmSpec((spec) => installHooksFromNpmSpec({ spec }));

    const run = runCommandWithTimeoutMock;
    mockNpmPackMetadataResult(run, {
      id: "@openclaw/test-hooks@0.0.2-beta.1",
      name: "@openclaw/test-hooks",
      version: "0.0.2-beta.1",
      filename: "test-hooks-0.0.2-beta.1.tgz",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });

    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks",
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("prerelease version 0.0.2-beta.1");
      expect(result.error).toContain('"@openclaw/test-hooks@beta"');
    }
  });
});

describe("gmail watcher", () => {
  it("detects address already in use errors", () => {
    expect(isAddressInUseError("listen tcp 127.0.0.1:8788: bind: address already in use")).toBe(
      true,
    );
    expect(isAddressInUseError("EADDRINUSE: address already in use")).toBe(true);
    expect(isAddressInUseError("some other error")).toBe(false);
  });
});
