import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPrivateQaCliModule } from "./private-qa-cli.js";

describe("private-qa-cli", () => {
  const tempDirs: string[] = [];
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
  });

  it("loads the private QA CLI from a source checkout path", async () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-private-qa-source-"));
    tempDirs.push(repoRoot);
    const expectedPaths = new Set([
      path.join(repoRoot, ".git"),
      path.join(repoRoot, "src"),
      path.join(repoRoot, "dist", "plugin-sdk", "qa-lab.js"),
    ]);
    let importedSpecifier: string | undefined;
    const importModule = vi.fn(async (specifier: string) => {
      importedSpecifier = specifier;
      return {
        isQaLabCliAvailable: expect.any(Function),
        registerQaLabCli: expect.any(Function),
      };
    });

    const module = await loadPrivateQaCliModule({
      importModule,
      resolvePackageRootSync: () => repoRoot,
      existsSync: (filePath) => typeof filePath === "string" && expectedPaths.has(filePath),
    });

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importedSpecifier).toContain("/dist/plugin-sdk/qa-lab.js");
    expect(module).toMatchObject({
      isQaLabCliAvailable: expect.any(Function),
      registerQaLabCli: expect.any(Function),
    });
  });

  it("rejects non-source package roots even when private QA is enabled", async () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-private-qa-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf8");
    const importModule = vi.fn(async () => ({}));

    expect(() =>
      loadPrivateQaCliModule({
        resolvePackageRootSync: () => root,
        importModule,
      }),
    ).toThrow("Private QA CLI is only available from an OpenClaw source checkout.");
    expect(importModule).not.toHaveBeenCalled();
  });

  it("rejects when the private QA env flag is disabled", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    const importModule = vi.fn(async () => ({}));

    expect(() => loadPrivateQaCliModule({ importModule })).toThrow(
      "Private QA CLI is only available from an OpenClaw source checkout.",
    );
    expect(importModule).not.toHaveBeenCalled();
  });
});
