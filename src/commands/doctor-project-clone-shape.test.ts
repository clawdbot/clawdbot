import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import { runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import {
  registerClonedProjectRegistry,
  registerProjectRegistry,
} from "../projects/project-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const execFileAsync = promisify(execFile);
const checkId = "core/doctor/project-clone-shape";
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args])).stdout.trim();
}

describe("doctor project clone shape", () => {
  it.each(["full", "partial", "shallow", "both", "missing"])(
    "inspects only registry clones and reports %s clone repair",
    async (shape) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-clones-" }, async (state) => {
        const source = state.path("source");
        await git(state.root, "init", "-b", "main", source);
        await git(source, "config", "user.name", "OpenClaw Test");
        await git(source, "config", "user.email", "test@example.invalid");
        for (const content of ["first", "second"]) {
          await fs.writeFile(path.join(source, "README.md"), `${content}\n`);
          await git(source, "add", ".");
          await git(source, "commit", "-m", content);
        }
        const origin = state.path("origin.git");
        await git(state.root, "clone", "--bare", source, origin);
        await git(origin, "config", "uploadpack.allowFilter", "true");
        const originUrl = pathToFileURL(origin).href;
        const ignored = state.path("workspace");
        await git(state.root, "clone", "--filter=blob:none", originUrl, ignored);
        const cfg = { agents: { defaults: { workspace: ignored } } };
        const clone = state.path("project's clone");
        const partial = shape === "partial" || shape === "both";
        const shallow = shape === "shallow" || shape === "both";
        await git(
          state.root,
          "clone",
          ...(partial ? ["--filter=blob:none"] : []),
          ...(shallow ? ["--depth=1"] : []),
          originUrl,
          clone,
        );
        await registerClonedProjectRegistry({ path: clone, name: "Stored project", originUrl });
        await registerProjectRegistry({ path: ignored, name: "User checkout" });
        if (shape === "both") {
          await git(clone, "config", "remote.https://example.invalid/project.git.promisor", "true");
          await git(
            clone,
            "config",
            "remote.https://example.invalid/project.git.partialclonefilter",
            "blob:none",
          );
          await git(clone, "config", "extensions.partialclone", "origin");
        }
        const configBefore = await fs.readFile(path.join(clone, ".git", "config"), "utf8");
        if (shape === "missing") {
          await fs.rm(clone, { recursive: true, force: true });
        }
        const checks = (await resolveDoctorContributionHealthChecks()).filter(
          (check) => check.id === checkId,
        );
        const detect = async () =>
          (
            await runDoctorLintChecks(
              { mode: "lint", cfg, runtime },
              { checks, includeAllChecks: true },
            )
          ).findings;
        const findings = await detect();
        if (shape === "full") {
          expect(findings).toEqual([]);
          return;
        }
        expect(findings).toHaveLength(1);
        const finding = findings[0]!;
        expect(finding).toMatchObject({ checkId, severity: "warning", path: clone });
        expect(finding.message).toContain("Stored project");
        if (shape === "missing") {
          expect(finding.message).toContain("Skipped");
          return;
        }
        expect(finding.message).toContain(`shallow=${shallow}`);
        if (partial) {
          expect(finding.message).toContain("remote.origin.promisor");
          expect(finding.message).toContain("remote.origin.partialclonefilter");
        }
        if (shape === "both") {
          expect(finding.message).toContain("remote.https://example.invalid/project.git.promisor");
          expect(finding.message).toContain(
            "remote.https://example.invalid/project.git.partialclonefilter",
          );
          expect(finding.message).toContain("extensions.partialclone");
        }
        expect(await fs.readFile(path.join(clone, ".git", "config"), "utf8")).toBe(configBefore);
        expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe(String(shallow));
        // Exercise the printed operator commands against the local origin.
        await execFileAsync("sh", ["-ec", finding.fixHint!.split("\n").slice(1, -1).join("\n")]);
        expect(await detect()).toEqual([]);
        expect(await git(clone, "rev-list", "--objects", "--missing=print", "--all")).not.toMatch(
          /^\?/m,
        );
      });
    },
  );
});
