// Docker E2E Helper Cli tests cover docker e2e helper cli script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const EXACT_TARGET_REF = "1".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runHelper(script: string, ...args: Array<string | Record<string, string>>) {
  const maybeEnv = args.at(-1);
  const env =
    maybeEnv && typeof maybeEnv === "object"
      ? (args.pop() as unknown as Record<string, string>)
      : {};
  return spawnSync(process.execPath, [script, ...(args as string[])], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GH_FORCE_TTY: "0",
      NO_COLOR: "1",
      ...env,
    },
  });
}

function downloadedDir(stdout: string) {
  const match = stdout.match(/^Downloaded: (.+)$/mu);
  const dir = match?.[1];
  if (!dir) {
    throw new Error(`missing downloaded dir in stdout:\n${stdout}`);
  }
  return dir;
}

function emittedWorkflowCommands(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes("gh workflow run"))
    .map((line) => line.slice(line.indexOf("gh workflow run")));
}

function expectDeclaredDispatchInputs(command: string): void {
  const workflow = parse(readFileSync(LIVE_E2E_WORKFLOW, "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
  const declared = new Set(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}));
  const emitted = [...command.matchAll(/(?:^|\s)-f\s+([a-z0-9_]+)=/gu)].map((match) => match[1]);
  expect(emitted.length).toBeGreaterThan(0);
  for (const input of emitted) {
    expect(declared.has(input), `undeclared workflow_dispatch input: ${input}`).toBe(true);
  }
}

describe("Docker E2E helper CLIs", () => {
  it("prints scheduler helper help without throwing a stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
  });

  it("prints scheduler helper usage errors without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects oversized scheduler helper JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-helper-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e.mjs", "failed-reruns", file, {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prints timings help without treating --help as an artifact path", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json>",
    );
  });

  it("rejects malformed timings limits without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "summary.json", "--limit=1e3");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--limit must be a positive integer");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects unknown timings options without treating them as artifact paths", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --wat");
    expect(result.stderr).toContain(
      "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json>",
    );
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects oversized timing JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-timings-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e-timings.mjs", file, {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects missing timings limits without a Node stack trace", () => {
    for (const limit of [undefined, "-h"]) {
      const args = ["scripts/docker-e2e-timings.mjs", "summary.json", "--limit"];
      const result = runHelper(args[0]!, ...args.slice(1), ...(limit === undefined ? [] : [limit]));

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--limit requires a value");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    }
  });

  it("prints rerun help without detecting the GitHub repository", () => {
    const result = runHelper("scripts/docker-e2e-rerun.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "node scripts/docker-e2e-rerun.mjs <run-id|summary.json|failures.json>",
    );
  });

  it("rejects oversized rerun JSON artifacts without a Node stack trace", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-`);
    try {
      const file = path.join(root, "summary.json");
      writeFileSync(file, `${JSON.stringify({ filler: "x".repeat(128) })}\n`, "utf8");

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", EXACT_TARGET_REF, {
        OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES: "64",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSON artifact exceeded 64 bytes");
      expect(result.stderr).not.toContain("Error:");
      expect(result.stderr).not.toContain("at file:");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["summary.json", "failures.json"])(
    "prints local cleanup reruns without synthesizing Docker lane reruns from %s",
    (fileName) => {
      const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-`);
      try {
        const cleanupFailure = {
          lane: "cleanup-smoke",
          logFile: "cleanup-smoke.log",
          name: "cleanup-smoke",
          rerunCommand: "pnpm test:docker:cleanup",
          status: 42,
          targetable: false,
        };
        const payload =
          fileName === "summary.json"
            ? {
                failures: [cleanupFailure],
                lanes: [
                  {
                    name: "gateway-network",
                    status: 0,
                  },
                ],
                ref: "HEAD",
                status: "failed",
              }
            : {
                lanes: [cleanupFailure],
                ref: "HEAD",
                status: "failed",
              };
        const file = path.join(root, fileName);
        writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

        const result = runHelper("scripts/docker-e2e-rerun.mjs", file);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Failed Docker E2E entries: cleanup-smoke");
        expect(result.stdout).toContain("No targetable failed Docker E2E lanes found.");
        expect(result.stdout).toContain("- cleanup-smoke: pnpm test:docker:cleanup");
        expect(result.stdout).not.toContain("docker_lanes='cleanup-smoke'");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("ignores artifact-provided GitHub rerun commands", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-command-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand: "echo poisoned-command",
                name: "gateway-network",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", EXACT_TARGET_REF);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("docker_lanes='gateway-network'");
      expect(result.stdout).not.toContain("poisoned-command");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["failures.json", (targetRef: string) => ({ ref: targetRef })],
    ["summary.json", (targetRef: string) => ({ github: { selectedSha: targetRef } })],
  ] as const)(
    "uses the exact artifact target from %s instead of the workflow head",
    (name, refData) => {
      const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-ref-`);
      try {
        const targetRef = "a".repeat(40);
        const workflowHead = "b".repeat(40);
        const file = path.join(root, name);
        writeFileSync(
          file,
          `${JSON.stringify(
            {
              ...refData(targetRef),
              failures: [{ name: "gateway-network", status: 1 }],
              lanes: [{ name: "gateway-network", status: 1 }],
              status: "failed",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const result = runHelper("scripts/docker-e2e-rerun.mjs", file, {
          GITHUB_SHA: workflowHead,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`Ref: ${targetRef}`);
        expect(result.stdout).toContain(`-f ref='${targetRef}'`);
        expect(result.stdout).not.toContain(workflowHead);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("lets an explicit target ref override artifact refs", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-ref-override-`);
    try {
      const artifactRef = "a".repeat(40);
      const explicitRef = "c".repeat(40);
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify({
          images: { bare: "ghcr.io/openclaw/openclaw-bare:artifact-a" },
          lanes: [{ name: "gateway-network", status: 1 }],
          ref: artifactRef,
          status: "failed",
        })}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", explicitRef);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Ref: ${explicitRef}`);
      expect(result.stdout).toContain(`-f ref='${explicitRef}'`);
      expect(result.stdout).not.toContain(`-f ref='${artifactRef}'`);
      expect(result.stdout).not.toContain("docker_e2e_bare_image=");
      expect(result.stdout).not.toContain("shared_image_policy=existing-only");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires an artifact target ref when no explicit ref is supplied", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-ref-missing-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify({
          lanes: [{ name: "gateway-network", status: 1 }],
          status: "failed",
        })}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing an exact target ref");
      expect(result.stderr).toContain("pass --ref explicitly");
      expect(result.stderr).not.toContain("HEAD");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a non-exact artifact target for a targetable rerun", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-ref-artifact-invalid-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify({
          lanes: [{ name: "gateway-network", status: 1 }],
          ref: "HEAD",
          status: "failed",
        })}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid artifact target ref");
      expect(result.stderr).toContain("full commit SHA");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["abc123", "A".repeat(40), "main"])(
    "rejects a non-exact explicit target ref: %s",
    (explicitRef) => {
      const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-ref-invalid-`);
      try {
        const file = path.join(root, "failures.json");
        writeFileSync(
          file,
          `${JSON.stringify({
            lanes: [{ name: "gateway-network", status: 1 }],
            status: "failed",
          })}\n`,
          "utf8",
        );

        const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", explicitRef);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("exact lowercase 40-character target SHA");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("preserves declared rerun inputs but ignores package and workflow refs", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-inputs-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'full-release-validation-temp-deleted' -f package_artifact_run_id='12345' -f package_artifact_name='docker-e2e-package' -f docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test' -f published_upgrade_survivor_baselines='openclaw@2026.5.3' -f published_upgrade_survivor_scenarios='plugin-dependency-cleanup' -f allow_unreleased_changelog=true -f unsafe_input='do-not-copy'",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
            ],
            ref: EXACT_TARGET_REF,
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", EXACT_TARGET_REF);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const combinedCommand = result.stdout.match(/Combined GitHub rerun:\n([^\n]+)/u)?.[1] ?? "";
      expect(combinedCommand).not.toContain("--ref 'full-release-validation-temp-deleted'");
      expect(combinedCommand).not.toContain("package_artifact_run_id=");
      expect(combinedCommand).not.toContain("package_artifact_name=");
      expect(combinedCommand).toContain(
        "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'",
      );
      expect(combinedCommand).toContain("shared_image_policy=existing-only");
      expect(combinedCommand).toContain("published_upgrade_survivor_baselines='openclaw@2026.5.3'");
      expect(combinedCommand).toContain(
        "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
      );
      expect(combinedCommand).toContain("allow_unreleased_changelog=true");
      expect(combinedCommand).not.toContain("unsafe_input");
      expect(result.stdout).not.toContain("package_artifact_run_id=");
      expect(result.stdout).not.toContain("package_artifact_name=");
      expect(result.stdout).toContain(
        "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-bare:test'",
      );
      expect(result.stdout).toContain("shared_image_policy=existing-only");
      expect(result.stdout).toContain("published_upgrade_survivor_baselines='openclaw@2026.5.3'");
      expect(result.stdout).toContain(
        "published_upgrade_survivor_scenarios='plugin-dependency-cleanup'",
      );
      expect(result.stdout).not.toContain("unsafe_input");
      expect(result.stdout).not.toContain("do-not-copy");
      const commands = emittedWorkflowCommands(result.stdout);
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expectDeclaredDispatchInputs(command);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non-boolean unreleased changelog intent from summary artifacts", () => {
    const root = tempDirs.make("openclaw-docker-e2e-rerun-inputs-");
    const file = path.join(root, "summary.json");
    writeFileSync(
      file,
      `${JSON.stringify({
        allowUnreleasedChangelog: "true",
        failures: [{ name: "install-e2e", status: 1 }],
        github: { selectedSha: EXACT_TARGET_REF },
        status: "failed",
      })}\n`,
      "utf8",
    );

    const result = runHelper("scripts/docker-e2e-rerun.mjs", file);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("allow_unreleased_changelog");
  });

  it("groups combined reruns by recovered workflow inputs", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-groups-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.3' -f allow_unreleased_changelog=1",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.2'",
                name: "published-upgrade-survivor-openclaw-2026-5-2",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", EXACT_TARGET_REF);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Combined GitHub reruns:");
      expect(result.stdout).toContain(
        "- published-upgrade-survivor-openclaw-2026-5-3: gh workflow run",
      );
      expect(result.stdout).toContain(
        "- published-upgrade-survivor-openclaw-2026-5-2: gh workflow run",
      );
      expect(result.stdout).toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-3'",
      );
      expect(result.stdout).toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-2'",
      );
      expect(result.stdout).not.toContain(
        "docker_lanes='published-upgrade-survivor-openclaw-2026-5-3 published-upgrade-survivor-openclaw-2026-5-2'",
      );
      expect(result.stdout).not.toContain("allow_unreleased_changelog");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("merges duplicate lane entries before printing reruns", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-merge-`);
    try {
      const file = path.join(root, "failures.json");
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            lanes: [
              {
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
              {
                ghWorkflowCommand:
                  "gh workflow run 'openclaw-live-and-e2e-checks-reusable.yml' --ref 'release/2026.6' -f published_upgrade_survivor_baselines='openclaw@2026.5.3'",
                name: "published-upgrade-survivor-openclaw-2026-5-3",
                status: 1,
              },
            ],
            status: "failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", EXACT_TARGET_REF);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const combinedCommand = result.stdout.match(/Combined GitHub rerun:\n([^\n]+)/u)?.[1] ?? "";
      expect(combinedCommand).not.toContain("--ref 'release/2026.6'");
      expect(combinedCommand).toContain("published_upgrade_survivor_baselines='openclaw@2026.5.3'");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("downloads GitHub run artifacts into distinct default directories", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-gh-`);
    const generatedDirs: string[] = [];
    try {
      const binDir = path.join(root, "bin");
      const ghPath = path.join(binDir, "gh");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        ghPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'run' && args[1] === 'view') {",
          "  console.log(JSON.stringify({",
          "    conclusion: 'failure',",
          "    databaseId: 12345,",
          "    headBranch: 'main',",
          "    headSha: 'abc123',",
          "    status: 'completed',",
          "    url: 'https://github.com/openclaw/openclaw/actions/runs/12345',",
          "    workflowName: 'OpenClaw Live and E2E Checks',",
          "  }));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'api') {",
          "  console.log(JSON.stringify([{ expired: false, name: 'docker-e2e-gateway-network' }]));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'run' && args[1] === 'download') {",
          "  const dir = args[args.indexOf('--dir') + 1];",
          "  fs.mkdirSync(path.join(dir, 'artifact'), { recursive: true });",
          "  fs.writeFileSync(path.join(dir, 'artifact', 'failures.json'), JSON.stringify({",
          "    lanes: [{ name: 'gateway-network', status: 1 }],",
          "    ref: 'd'.repeat(40),",
          "    status: 'failed',",
          "  }));",
          "  process.exit(0);",
          "}",
          "console.error(`unexpected gh args: ${args.join(' ')}`);",
          "process.exit(1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(ghPath, 0o755);

      const env = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const first = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        env,
      );
      const second = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        env,
      );

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      const firstDir = downloadedDir(first.stdout);
      const secondDir = downloadedDir(second.stdout);
      generatedDirs.push(firstDir, secondDir);
      expect(firstDir).not.toBe(secondDir);
      expect(path.basename(firstDir)).toMatch(/^openclaw-docker-e2e-rerun-12345-/u);
      expect(path.basename(secondDir)).toMatch(/^openclaw-docker-e2e-rerun-12345-/u);
      expect(existsSync(path.join(firstDir, "artifact", "failures.json"))).toBe(true);
      expect(existsSync(path.join(secondDir, "artifact", "failures.json"))).toBe(true);
      expect(first.stdout).toContain(`-f ref='${"d".repeat(40)}'`);
      expect(first.stdout).not.toContain("-f ref='abc123'");
      expect(second.stdout).toContain(`-f ref='${"d".repeat(40)}'`);
    } finally {
      for (const dir of generatedDirs) {
        rmSync(dir, { force: true, recursive: true });
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed when downloaded artifacts contain mixed target refs", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-mixed-refs-`);
    try {
      const binDir = path.join(root, "bin");
      const outputDir = path.join(root, "artifacts");
      const ghPath = path.join(binDir, "gh");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        ghPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'run' && args[1] === 'view') {",
          "  console.log(JSON.stringify({ headBranch: 'main', headSha: 'f'.repeat(40), url: 'https://example.invalid/run', workflowName: 'Live E2E' }));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'api') {",
          "  console.log(JSON.stringify([",
          "    { expired: false, name: 'docker-e2e-a' },",
          "    { expired: false, name: 'docker-e2e-b' },",
          "  ]));",
          "  process.exit(0);",
          "}",
          "if (args[0] === 'run' && args[1] === 'download') {",
          "  const name = args[args.indexOf('--name') + 1];",
          "  const dir = args[args.indexOf('--dir') + 1];",
          "  const target = path.join(dir, name);",
          "  fs.mkdirSync(target, { recursive: true });",
          "  fs.writeFileSync(path.join(target, 'failures.json'), JSON.stringify({",
          "    lanes: [{ name: name.endsWith('-a') ? 'gateway-network' : 'install-e2e', status: 1 }],",
          "    ref: (name.endsWith('-a') ? 'a' : 'b').repeat(40),",
          "    status: 'failed',",
          "  }));",
          "  process.exit(0);",
          "}",
          "console.error(`unexpected gh args: ${args.join(' ')}`);",
          "process.exit(1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(ghPath, 0o755);

      const result = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        "--dir",
        outputDir,
        { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("mixed target refs");
      expect(result.stderr).toContain("a".repeat(40));
      expect(result.stderr).toContain("b".repeat(40));

      const explicitRef = "c".repeat(40);
      const override = runHelper(
        "scripts/docker-e2e-rerun.mjs",
        "12345",
        "--repo",
        "openclaw/openclaw",
        "--dir",
        outputDir,
        "--ref",
        explicitRef,
        { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      );
      expect(override.status, override.stderr).toBe(0);
      expect(override.stdout).toContain(`-f ref='${explicitRef}'`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
