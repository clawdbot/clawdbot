import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import * as processRunner from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { runPackageInstallUpdate } from "./update-command-package.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "1.0.0",
  "file:/owned/candidate.tgz",
  "https://example.invalid/candidate.tgz",
  "openclaw@file:/owned/candidate",
  "openclaw@1.0.0",
])(
  "honors the explicit package artifact without changing registry no-op semantics: %s",
  async (tag) => {
    await withTestDir({ prefix: "update-exact-artifact-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const target = createNpmTarget(globalRoot);
      const root = path.join(globalRoot, "openclaw");
      await writePackageRoot(root, "1.0.0");
      const launcher = path.join(base, "prefix", "bin", "openclaw");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "previous launcher\n");
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
        let stdout = "";
        if (argv.join(" ") === "npm --version") {
          stdout = "12.0.0\n";
        } else if (argv.join(" ") === "npm root -g") {
          stdout = `${globalRoot}\n`;
        } else if (argv.includes("--prefix") && (argv.includes("install") || argv.includes("i"))) {
          const prefix = argv[argv.indexOf("--prefix") + 1];
          if (!prefix) {
            throw new Error("Missing actual staged prefix");
          }
          await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "1.0.0");
          await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
          await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
        } else {
          throw new Error(`Unexpected package command: ${argv.join(" ")}`);
        }
        return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
      });
      const stopped = new Error("pause at owned pre-activation boundary");
      const validateCandidate = vi.fn(async (candidate: string) => {
        expect(candidate).not.toBe(root);
        expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
        return [];
      });
      const beforeActivate = vi.fn(async () => {
        throw stopped;
      });
      const onTransaction = vi.fn();
      const update = runPackageInstallUpdate({
        root,
        installKind: "package",
        tag: tag.startsWith("openclaw@") ? "latest" : tag,
        timeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        installEnv: tag.startsWith("openclaw@") ? { OPENCLAW_UPDATE_PACKAGE_SPEC: tag } : {},
        installTarget: target,
        validateCandidate,
        beforeActivate,
        onTransaction,
      });
      if (tag === "1.0.0" || tag === "openclaw@1.0.0") {
        expect(await update).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(beforeActivate).not.toHaveBeenCalled();
      } else {
        await expect(update).rejects.toBe(stopped);
        expect(validateCandidate).toHaveBeenCalledOnce();
        expect(beforeActivate).toHaveBeenCalledOnce();
      }
      expect(onTransaction).not.toHaveBeenCalled();
      expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
        "1.0.0",
      );
    });
  },
);
