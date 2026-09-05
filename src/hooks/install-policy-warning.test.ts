import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { packToArchive } from "../plugins/test-helpers/archive-fixtures.js";

const scanPackageInstallSourceMock = vi.fn();
const scanInstalledPackageDependencyTreeMock = vi.fn();
const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanPackageInstallSourceMock(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) =>
    scanInstalledPackageDependencyTreeMock(...args),
}));

const { installHooksFromPath, installHooksFromNpmSpec } = await import("./install.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeHookInstallFixture() {
  const root = tempDirs.make("openclaw-hook-policy-");
  const pkgDir = path.join(root, "source");
  const hookDir = path.join(pkgDir, "hooks", "one-hook");
  const hooksDir = path.join(root, "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@acme/canonical-hooks",
      version: "1.0.0",
      openclaw: { hooks: ["./hooks/one-hook"] },
    }),
  );
  fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: one-hook\n---\n");
  fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
  return { root, pkgDir, hookDir, hooksDir };
}

describe("hook install policy warnings", () => {
  beforeEach(() => {
    scanPackageInstallSourceMock.mockReset();
    scanInstalledPackageDependencyTreeMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
  });

  it("passes acknowledgement through both scan stages", async () => {
    const root = tempDirs.make("openclaw-hook-policy-");
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "HOOK.md"), "---\nname: my-hook\n---\n");
    fs.writeFileSync(path.join(source, "handler.ts"), "export default async () => {};\n");
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });

    await installHooksFromPath({
      path: source,
      hooksDir: path.join(root, "hooks"),
      onInstallPolicyWarning,
    });

    for (const scan of [scanPackageInstallSourceMock, scanInstalledPackageDependencyTreeMock]) {
      expect(scan).toHaveBeenCalledWith(expect.objectContaining({ onInstallPolicyWarning }));
    }
  });

  it.each(["package", "single hook"] as const)(
    "does not publish a %s after its authority closes during staged preparation",
    async (source) => {
      const { pkgDir, hookDir, hooksDir } = makeHookInstallFixture();
      let authorityActive = true;
      scanInstalledPackageDependencyTreeMock.mockImplementationOnce(async () => {
        authorityActive = false;
      });
      const result = await installHooksFromPath({
        path: source === "package" ? pkgDir : hookDir,
        hooksDir,
        beforePersistentApply: () => {
          if (!authorityActive) {
            throw new Error("hook installation authority closed");
          }
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("hook installation authority closed"),
      });
      expect(scanInstalledPackageDependencyTreeMock).toHaveBeenCalledOnce();
      const hookPackId = source === "package" ? "canonical-hooks" : "one-hook";
      expect(fs.existsSync(path.join(hooksDir, hookPackId))).toBe(false);
    },
  );

  it.each(
    (["package", "single hook", "archive", "npm"] as const).flatMap((source) =>
      (["install", "update"] as const).map((mode) => ({ source, mode })),
    ),
  )("rolls back a deferred $source $mode payload", async ({ source, mode }) => {
    const { root, pkgDir, hookDir, hooksDir } = makeHookInstallFixture();
    const hookPackId = source === "single hook" ? "one-hook" : "canonical-hooks";
    const targetDir = path.join(hooksDir, hookPackId);
    const previousMarker = path.join(targetDir, "previous.txt");
    if (mode === "update") {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(previousMarker, "previous payload");
    }
    let sourcePath = source === "single hook" ? hookDir : pkgDir;
    if (source === "archive" || source === "npm") {
      sourcePath = await packToArchive({ pkgDir, outDir: root, outName: "hooks.tgz" });
    }
    if (source === "npm") {
      runCommandWithTimeoutMock.mockImplementation(async (argv, options) => {
        if (argv[0] !== "npm" || argv[1] !== "pack" || !options.cwd) {
          throw new Error("unexpected npm fixture command");
        }
        fs.copyFileSync(sourcePath, path.join(options.cwd, "hooks.tgz"));
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "@acme/canonical-hooks", version: "1.0.0", filename: "hooks.tgz" },
          ]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    }
    const result = await (source === "npm"
      ? installHooksFromNpmSpec(
          requestDeferredPackageDirInstall({
            spec: "@acme/canonical-hooks@1.0.0",
            hooksDir,
            mode,
          }),
        )
      : installHooksFromPath(
          requestDeferredPackageDirInstall({ path: sourcePath, hooksDir, mode }),
        ));

    expect(result.ok).toBe(true);
    const transaction = result.ok ? resolvePackageDirInstallTransaction(result) : undefined;
    if (!transaction) {
      throw new Error("expected deferred hook payload transaction");
    }
    const installedHook =
      source === "single hook" ? targetDir : path.join(targetDir, "hooks", "one-hook");
    expect(fs.existsSync(path.join(installedHook, "handler.ts"))).toBe(true);
    await transaction.rollback();
    if (mode === "update") {
      expect(fs.readFileSync(previousMarker, "utf8")).toBe("previous payload");
    } else {
      expect(fs.existsSync(targetDir)).toBe(false);
    }
    expect(fs.existsSync(path.join(hookDir, "handler.ts"))).toBe(true);
  });
});
