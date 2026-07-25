import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const WORKFLOW_CASES = [
  {
    name: "iOS",
    path: ".github/workflows/ios-periphery.yml",
    scopedPath: "apps/ios/Sources/Test.swift",
  },
  {
    name: "macOS",
    path: ".github/workflows/macos-periphery.yml",
    scopedPath: "apps/macos/Sources/OpenClaw/Test.swift",
  },
  {
    name: "shared OpenClawKit",
    path: ".github/workflows/shared-openclawkit-periphery.yml",
    scopedPath: "apps/shared/OpenClawKit/Sources/OpenClawKit/Test.swift",
  },
] as const;

type WorkflowStep = {
  id?: string;
  name?: string;
  with?: {
    "fetch-depth"?: number;
    script?: string;
  };
};

type ScopeWorkflow = {
  on?: {
    pull_request?: {
      paths?: string[];
      types?: string[];
    };
  };
  jobs?: {
    scope?: {
      steps?: WorkflowStep[];
    };
  };
};

type ScopeOptions = {
  diffExitCode?: number;
  draft?: boolean;
  eventName?: string;
  files?: Array<string | { filename: string; previous_filename?: string }>;
};

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function readWorkflow(workflowPath: string): ScopeWorkflow {
  return parse(readFileSync(workflowPath, "utf8")) as ScopeWorkflow;
}

function scopeScript(workflowPath: string): string {
  const step = readWorkflow(workflowPath).jobs?.scope?.steps?.find(
    (candidate) => candidate.id === "scope",
  );
  if (!step?.with?.script) {
    throw new Error(`missing Periphery scope script in ${workflowPath}`);
  }
  return step.with.script;
}

async function runScope(workflowPath: string, options: ScopeOptions): Promise<string | undefined> {
  const outputs = new Map<string, string>();
  const context = {
    eventName: options.eventName ?? "pull_request",
    payload: { pull_request: { draft: options.draft ?? false, number: 123 } },
  };
  const exec = {
    async getExecOutput(command: string, args: string[]) {
      if (command !== "git" || args.slice(0, 5).join(" ") !== "diff --quiet HEAD^1 HEAD --") {
        throw new Error(`unexpected scope command: ${command} ${args.join(" ")}`);
      }
      if (options.diffExitCode !== undefined) {
        return { exitCode: options.diffExitCode };
      }
      const pathspecs = args.slice(5);
      const filenames = (options.files ?? []).flatMap((file) =>
        typeof file === "string"
          ? [file]
          : [file.filename, file.previous_filename].filter((name): name is string => Boolean(name)),
      );
      const changed = filenames.some((filename) =>
        pathspecs.some((pathspec) =>
          pathspec.endsWith("/") ? filename.startsWith(pathspec) : filename === pathspec,
        ),
      );
      return { exitCode: changed ? 1 : 0 };
    },
  };
  const execute = compileFunction(`return (async () => {\n${scopeScript(workflowPath)}\n})();`, [
    "context",
    "core",
    "exec",
  ]) as (context: unknown, core: unknown, exec: unknown) => Promise<void>;

  await execute(
    context,
    { setOutput: (name: string, value: string) => outputs.set(name, value) },
    exec,
  );
  return outputs.get("should-scan");
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFixture(repoRoot: string, relativePath: string, contents: string): void {
  const filePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

describe("Periphery scope workflows", () => {
  it.each(WORKFLOW_CASES)("uses the synthetic merge parent for $name scope", ({ path }) => {
    const workflow = readWorkflow(path);
    const steps = workflow.jobs?.scope?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout");
    const script = scopeScript(path);

    expect(workflow.on?.pull_request?.types).toContain("converted_to_draft");
    expect(workflow.on?.pull_request?.paths).toBeUndefined();
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    expect(steps.some((step) => step.name === "Ensure base commit")).toBe(false);
    expect(script).toContain('"HEAD^1"');
    expect(script).not.toContain("pulls.listFiles");
    expect(() =>
      compileFunction(`return (async () => {\n${script}\n})();`, ["context", "core", "exec"]),
    ).not.toThrow();
  });

  it.each(WORKFLOW_CASES)("selects only $name scope changes", async ({ path, scopedPath }) => {
    await expect(runScope(path, { files: [scopedPath] })).resolves.toBe("true");
    await expect(runScope(path, { files: ["docs/index.md"] })).resolves.toBe("false");
    await expect(runScope(path, { draft: true, files: [scopedPath] })).resolves.toBe("false");
    await expect(runScope(path, { eventName: "workflow_dispatch" })).resolves.toBe("true");
    await expect(
      runScope(path, {
        files: [{ filename: "docs/Moved.swift", previous_filename: scopedPath }],
      }),
    ).resolves.toBe("true");
    await expect(runScope(path, { diffExitCode: 128 })).rejects.toThrow(
      "git diff failed with exit code 128",
    );
  });

  it("ignores scoped files added only by base-branch drift", async () => {
    const repoRoot = makeTempRepoRoot(tempDirs, "openclaw-periphery-scope-");
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.name", "OpenClaw Test"]);
    git(repoRoot, ["config", "user.email", "openclaw-test@example.com"]);

    writeFixture(repoRoot, "docs/base.md", "base\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "base"]);
    const eventBase = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["switch", "-c", "pr"]);
    writeFixture(repoRoot, "docs/pr.md", "pull request\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "pull request"]);

    git(repoRoot, ["switch", "main"]);
    writeFixture(
      repoRoot,
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Main.swift",
      "struct Main {}\n",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "advance main"]);
    git(repoRoot, ["merge", "--no-ff", "pr", "-m", "synthetic merge"]);

    const oldDiff = spawnSync(
      "git",
      ["diff", "--quiet", eventBase, "HEAD", "--", "apps/shared/OpenClawKit/"],
      { cwd: repoRoot },
    );
    expect(oldDiff.status).toBe(1);

    const outputs = new Map<string, string>();
    const execute = compileFunction(
      `return (async () => {\n${scopeScript(".github/workflows/shared-openclawkit-periphery.yml")}\n})();`,
      ["context", "core", "exec"],
    ) as (context: unknown, core: unknown, exec: unknown) => Promise<void>;
    await execute(
      { eventName: "pull_request", payload: { pull_request: { draft: false, number: 123 } } },
      { setOutput: (name: string, value: string) => outputs.set(name, value) },
      {
        async getExecOutput(command: string, args: string[]) {
          const result = spawnSync(command, args, { cwd: repoRoot });
          return { exitCode: result.status ?? 128 };
        },
      },
    );

    expect(outputs.get("should-scan")).toBe("false");
    expect(git(repoRoot, ["diff", "--name-only", "HEAD^1", "HEAD"])).toBe("docs/pr.md");
  });
});
