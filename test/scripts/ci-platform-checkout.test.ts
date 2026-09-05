import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, expect, it, vi } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import {
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  renderGitTestClock,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import {
  censusPreload,
  expectCensusClosed,
  registerWindowsCensusTests,
} from "./ci-windows-process-census.test-support.js";

// Each case owns its checkout and process trees. Overlap their real deadline
// and drain waits while keeping subprocess pressure bounded within one worker.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

// Execute both workflow policies against the same owned tree fixture. A leader's
// exit must not authorize workspace deletion, Git reuse, or final success.
const platformCases = [
  { scenario: "timeouts-exhausted", attempts: 3, code: 124, checkout: false },
  { scenario: "recovery", attempts: 4, code: 0, checkout: true },
  { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true },
  { scenario: "harness-timeout", attempts: 2, code: 124, checkout: true },
  { scenario: "git-failure", attempts: 1, code: 23, checkout: false },
  { scenario: "git-exit-124", attempts: 1, code: 124, checkout: false },
  { scenario: "pre-existing-lock", attempts: 1, code: 128, checkout: false },
  // Windows has no POSIX signals/ps boundary; native Job cancellation proof is separate.
  ...(process.platform === "win32" ? [] : ["SIGTERM", "SIGINT", "SIGHUP"]).map((signal, index) => ({
    scenario: `cancel-${signal}`,
    attempts: 1,
    code: [143, 130, 129][index],
    checkout: false,
  })),
  ...(process.platform === "win32"
    ? []
    : [{ scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false }]),
];
const linuxCases =
  process.platform === "win32"
    ? []
    : [
        { scenario: "timeouts-exhausted", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "recovery", attempts: 4, code: 0, checkout: true, deletions: 3 },
        { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true, deletions: 1 },
        { scenario: "git-failure", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "checkout-failure", attempts: 5, code: 1, checkout: true, deletions: 5 },
        { scenario: "harness-recovery", attempts: 4, code: 0, checkout: true, deletions: 2 },
        { scenario: "cancel-SIGTERM", attempts: 1, code: 143, checkout: false, deletions: 1 },
        { scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false, deletions: 1 },
        { scenario: "non-executable-git", attempts: 0, code: null, checkout: false, deletions: 0 },
        { scenario: "non-executable-find", attempts: 0, code: null, checkout: false, deletions: 0 },
      ];

it.concurrent.each([
  ...platformCases.map((entry) => Object.assign(entry, { linux: false, deletions: 0 })),
  ...linuxCases.map((entry) => Object.assign(entry, { linux: true })),
])(
  "preserves checkout ownership and fixture isolation (Linux=$linux, $scenario)",
  async ({ scenario, attempts, code, checkout, linux, deletions }) => {
    const setupFailure = scenario.startsWith("non-executable-");
    const run = readCiCheckoutStep(linux ? "checks-fast-core" : "checks-windows").run;

    const policyScenario = `${linux ? "linux:" : ""}${scenario}`;
    await withCiCheckoutFixture(
      policyScenario,
      (root) => {
        const workspace = path.join(root, "workspace");
        if (scenario.startsWith("cancel-")) {
          // Inject slow startup before fetch, beyond the former cancellation readiness deadline.
          writeFileSync(
            path.join(root, "fixture-config.json"),
            JSON.stringify({ initDelayMs: 4_100 }),
          );
        }
        if (linux) {
          writeFileSync(path.join(workspace, ".previous-checkout"), "stale\n");
        }
        if (scenario === "recovery") {
          // Reproduce startup beyond the old wall-clock budget without delaying other consumers.
          writeFileSync(path.join(root, "tree-start-delay-3.json"), "2100");
        }
        if (scenario === "git-exit-124") {
          // Slow child startup must not replace Git's injected exit with a fixture timeout.
          writeFileSync(path.join(root, "tree-start-delay-1.json"), "4100");
        }
        const accelerated = renderGitTestClock(run, { realDrain: scenario.startsWith("cancel-") });
        expect(accelerated).not.toBe(run);
        // A broken preflight must never let these negative fixture tests run real Git.
        writeFileSync(
          path.join(root, "checkout.sh"),
          setupFailure ? "printf 'unexpected workflow invocation\\n' >&2\nexit 99\n" : accelerated,
        );
        if (process.platform === "win32") {
          return censusPreload(
            root,
            "",
            ["timeouts-exhausted", "recovery", "early-leader-exit", "harness-timeout"].includes(
              scenario,
            ),
          );
        }
        return undefined;
      },
      (report, result, stderr, root) => {
        const workspace = path.join(root, "workspace");
        // Emit evidence before assertions; it remains available even for this deliberately red test.
        console.log(`${scenario}: ${JSON.stringify(report)}`);
        if (setupFailure) {
          expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
          expect(report.error, report.output).toContain(
            "Fixture setup: mock command resolution failed",
          );
          expect(report.error).toContain(scenario.slice("non-executable-".length));
          expect(result, stderr).toEqual({ code: 1, signal: null });
          expect(report.code).toBeNull();
          expect(report.output).toBe("");
          expect(report.commands).toEqual([]);
          expect(report.boundaries).toEqual([]);
          return;
        }
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(report.error, stderr).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expectCensusClosed(
          root,
          report.ownedProcesses.map((entry) => entry.pid),
        );
        expect(report.code).toBe(code);
        expect(readFileSync(path.join(workspace, ".git/preexisting.lock"), "utf8")).toBe(
          "not invocation-owned\n",
        );
        if (scenario === "pre-existing-lock") {
          expect(readFileSync(path.join(workspace, ".git/shallow.lock"), "utf8")).toBe(
            "not invocation-owned\n",
          );
        }
        if (scenario === "recovery") {
          for (let attempt = 1; attempt <= attempts; attempt++) {
            expect(
              readFileSync(path.join(root, "shared-git-cache", `${attempt}.lock`), "utf8"),
            ).toBe("outside Git ownership\n");
          }
        }
        if (scenario === "git-exit-124") {
          expect(report.output).toBe("");
        }
        const readyAttempts =
          scenario === "pre-existing-lock" ? [] : Array.from({ length: attempts }, (_, i) => i + 1);
        expect(report.readyAttempts).toEqual(readyAttempts);
        expect(report.boundaries.filter((entry) => entry.name.startsWith("fetch:"))).toHaveLength(
          attempts,
        );
        expect(report.boundaries.some((entry) => entry.name === "checkout")).toBe(checkout);
        expect(report.boundaries.filter((entry) => entry.name === "delete")).toHaveLength(
          deletions,
        );
        expect(report.output.includes("refusing reuse or retry")).toBe(
          scenario === "cleanup-failure",
        );
        if (scenario.startsWith("cancel-")) {
          const alive = report.ownedProcesses.filter((entry) => entry.attempt === 1);
          expect(alive.map((entry) => entry.role).toSorted()).toEqual([
            "child",
            "grandchild",
            "parent",
          ]);
          const owner = expectDefined(
            report.ownedProcesses.find((entry) => entry.role === "shell"),
            "workflow owner",
          );
          expect(owner.pid).toBeGreaterThan(1);
          const signal = scenario.slice("cancel-".length);
          expect(report.output).toContain(
            `cancellation: ${JSON.stringify({ signal, owner: owner.pid, alive })}\n`,
          );
        }
        if (code === 0) {
          const fetches = report.commands.filter(({ args }) => args.includes("fetch"));
          const candidateFetch = expectDefined(fetches[0], "candidate fetch");
          expect(candidateFetch.args).toContain(
            `+${"a".repeat(40)}:refs/remotes/origin/${linux ? "ci-target" : "checkout"}`,
          );
          expect(
            candidateFetch.args.includes(`+${"c".repeat(40)}:refs/remotes/origin/ci-ratchet-base`),
          ).toBe(linux && scenario === "early-leader-exit");
          if (linux) {
            expect(
              report.commands.filter(
                ({ args }) =>
                  args.join(" ") === `config --global --add safe.directory ${workspace}`,
              ),
            ).toHaveLength(deletions);
            expect(
              report.commands
                .filter(({ cwd, args }) => cwd === workspace && args[0] === "checkout")
                .every(
                  ({ args }) => args.join(" ") === `checkout --force --detach ${"a".repeat(40)}`,
                ),
            ).toBe(true);
          }
          expect(candidateFetch.cwd).toBe(workspace);
          expect(fetches.at(-1)?.cwd).toBe(path.join(workspace, ".ci-harness"));
          for (const { args } of fetches) {
            expect(args).toEqual(
              expect.arrayContaining(["--no-tags", "--no-recurse-submodules", "--depth=1"]),
            );
          }
          expect(fetches.at(-1)?.args).toContain(
            `+${"b".repeat(40)}:refs/remotes/origin/ci-harness`,
          );
          expect(
            report.commands.some(
              ({ args }) =>
                args.join(" ") ===
                "sparse-checkout set --no-cone /.github/actions/ /scripts/ios-screenshot-evidence.mjs /scripts/lib/direct-run.mjs",
            ),
          ).toBe(true);
          expect(report.commands.at(-1)?.args).toEqual([
            "checkout",
            "--force",
            "--detach",
            "b".repeat(40),
          ]);
        }
      },
    );
  },
  55_000,
);

it.concurrent.each([
  ...[
    ...(process.platform === "win32" ? [] : [{ kind: "linux-node", retained: false }]),
    ...(process.platform === "win32"
      ? []
      : [{ kind: "linux-node", retained: false, workflow: "previous", fetches: 2 }]),
    { kind: "platform", retained: false },
    { kind: "platform", retained: true },
    { kind: "platform", retained: false, workflow: "previous", fetches: 2 },
  ].map((entry) =>
    Object.assign(
      {
        event: "push",
        workflow: "same",
        target: "selected",
        code: 0,
        fetches: 1,
      },
      entry,
    ),
  ),
  ...(process.platform === "win32"
    ? []
    : [
        { event: "push", workflow: "same", target: "selected", code: 0, fetches: 2 },
        { event: "pull_request", workflow: "same", target: "selected", code: 0, fetches: 2 },
        { event: "pull_request", workflow: "previous", target: "selected", code: 0, fetches: 2 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "selected",
          code: 0,
          fetches: 2,
        },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "missing-branch",
          code: 0,
          fetches: 3,
        },
        { event: "pull_request", workflow: "missing", target: "selected", code: 0, fetches: 2 },
        { event: "push", workflow: "missing-action", target: "selected", code: 1, fetches: 2 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "moved-event",
          code: 0,
          fetches: 3,
        },
        { event: "push", workflow: "same", target: "missing-sha", code: 128, fetches: 1 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "missing-sha",
          code: 1,
          fetches: 2,
        },
      ].map((entry) => Object.assign(entry, { kind: "preflight", retained: false }))),
])(
  "materializes $kind trusted harness ($event, workflow=$workflow, target=$target, retained=$retained) without mutating the candidate",
  async ({ kind, retained, event, workflow, target, code, fetches }) => {
    const linux = kind !== "platform";
    const preflight = kind === "preflight";
    const posix = process.platform !== "win32";
    const action = ".github/actions/setup-node-env/action.yml";
    const executable = ".github/actions/tool/line\nbreak.sh";
    const link = ".github/actions/tool/link";
    const files = {
      [action]: "name: trusted $Format:%H$\n",
      ".github/actions/tool/with space.txt": "literal action bytes\n",
      ...(posix ? { [executable]: "#!/bin/sh\nexit 0\n" } : {}),
    };
    const evidenceScripts = {
      "scripts/ios-screenshot-evidence.mjs": "workflow evidence script\n",
      "scripts/lib/direct-run.mjs": "workflow direct-run script\n",
    };
    const releasePolicy = Object.fromEntries(
      ["scripts/lib/release-context.mjs", "scripts/lib/release-version.mjs"].map((name) => [
        name,
        readFileSync(name, "utf8"),
      ]),
    );
    const candidateFiles = {
      "candidate-only.txt": "candidate stays intact\n",
      "extensions/browser/icon.png": "complete binary path\0\xff",
      "ui/src/i18n/.i18n/de-DE.tm.jsonl": '{"fixture":"complete inventory"}\n',
      "scripts/lib/candidate-only.mjs": "export const candidate = true;\n",
    };
    let revision = "";
    let workflowRevision = "";
    let candidateAction = files[action];
    let candidateEvidenceScripts: Record<string, string> = evidenceScripts;
    await withCiCheckoutFixture(
      `${linux ? "linux:" : ""}configured`,
      (root) => {
        const source = path.join(root, "source");
        mkdirSync(source);
        const git = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], {
          encoding: "utf8",
        })
          .trim()
          .split(/\r?\n/u)[0];
        const gitConfig = path.join(root, "gitconfig");
        writeFileSync(gitConfig, "");
        const gitEnv = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Checkout fixture",
          GIT_AUTHOR_EMAIL: "checkout@example.invalid",
          GIT_COMMITTER_NAME: "Checkout fixture",
          GIT_COMMITTER_EMAIL: "checkout@example.invalid",
        };
        const run = (...args: string[]) =>
          execFileSync(expectDefined(git, "real Git executable"), ["-C", source, ...args], {
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...gitEnv },
            encoding: "utf8",
          }).trim();
        run("init");
        for (const [name, contents] of Object.entries({
          ...files,
          ...evidenceScripts,
          ...releasePolicy,
          ...candidateFiles,
        })) {
          mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
          writeFileSync(path.join(source, name), contents);
        }
        // Archive export would omit or rewrite these trusted action bytes.
        writeFileSync(path.join(source, ".gitattributes"), "* -text export-ignore export-subst\n");
        if (posix) {
          chmodSync(path.join(source, executable), 0o755);
          symlinkSync("line\nbreak.sh", path.join(source, link));
        }
        if (workflow === "missing-action") {
          rmSync(path.join(source, action));
        }
        run("add", "--all");
        run("commit", "--no-gpg-sign", "-m", "fixture revision");
        revision = run("rev-parse", "HEAD");
        workflowRevision = revision;
        if (workflow === "previous") {
          candidateAction = "name: candidate action must not replace the trusted workflow\n";
          writeFileSync(path.join(source, action), candidateAction);
          candidateEvidenceScripts = Object.fromEntries(
            Object.keys(evidenceScripts).map((name) => [
              name,
              `candidate ${path.basename(name)} must not replace the trusted workflow\n`,
            ]),
          );
          for (const [name, contents] of Object.entries(candidateEvidenceScripts)) {
            writeFileSync(path.join(source, name), contents);
          }
          run("add", action, ...Object.keys(evidenceScripts));
          run("commit", "--no-gpg-sign", "-m", "selected candidate");
          revision = run("rev-parse", "HEAD");
        } else if (workflow === "missing") {
          workflowRevision = "f".repeat(40);
        }
        if (target === "moved-event") {
          run("branch", "event", workflowRevision);
        }
        if (retained) {
          const staleAction = path.join(root, "workspace", ".ci-harness", action);
          mkdirSync(path.dirname(staleAction), { recursive: true });
          writeFileSync(staleAction, "name: stale platform action\n");
        }
        writeFileSync(
          path.join(root, "fixture-options.json"),
          JSON.stringify({
            localGit: { git, remote: source },
            fetchResults: [0, 0],
            cooperativeTrees: true,
            env: {
              ...gitEnv,
              CHECKOUT_KIND: kind,
              CHECKOUT_SHA: revision,
              CHECKOUT_REF:
                target === "missing-branch"
                  ? "refs/heads/missing"
                  : target === "missing-sha"
                    ? "f".repeat(40)
                    : revision,
              CHECKOUT_FALLBACK_REF: revision,
              CHECKOUT_EVENT_REF: target === "moved-event" ? "refs/heads/event" : "",
              GITHUB_EVENT_NAME: event,
              GITHUB_REPOSITORY: "fixture/checkout",
              CHECKOUT_TOKEN: "fixture-read-only-token",
              WORKFLOW_SHA: workflowRevision,
            },
          }),
        );
        writeFileSync(
          path.join(root, "checkout.sh"),
          renderGitTestClock(
            readCiCheckoutStep(
              preflight ? "preflight" : linux ? "checks-fast-core" : "checks-windows",
            ).run,
            {
              realClock: true,
            },
          ),
        );
      },
      (report, result, stderr, root) => {
        expect(result, `${stderr}\n${report.output}`).toEqual({ code: 0, signal: null });
        expect(report.error, report.output).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expect(report.code, report.output).toBe(code);
        expect(report.commands.filter(({ args }) => args[0] === "fetch")).toHaveLength(fetches);
        const workspace = path.join(root, "workspace");
        const harness = path.join(workspace, ".ci-harness");
        if (target === "missing-sha") {
          expect(existsSync(path.join(root, "candidate-index"))).toBe(false);
          expect(existsSync(harness)).toBe(false);
          return;
        }
        expect(readFileSync(path.join(workspace, ".git/index"))).toEqual(
          readFileSync(path.join(root, "candidate-index")),
        );
        expect(readFileSync(path.join(workspace, ".git/HEAD"), "utf8").trim()).toBe(revision);
        expect(readFileSync(path.join(workspace, ".git/config"), "utf8")).not.toContain(
          "AUTHORIZATION",
        );
        for (const [name, contents] of Object.entries(candidateFiles)) {
          expect(readFileSync(path.join(workspace, name), "utf8")).toBe(contents);
          expect(existsSync(path.join(harness, name))).toBe(false);
        }
        const workflowOwnsEvidence = kind === "platform" || kind === "linux-node";
        for (const name of Object.keys(evidenceScripts)) {
          expect(readFileSync(path.join(workspace, name), "utf8")).toBe(
            candidateEvidenceScripts[name],
          );
        }
        if (workflow === "missing-action") {
          expect(existsSync(path.join(workspace, action))).toBe(false);
          expect(existsSync(path.join(harness, action))).toBe(false);
          return;
        }
        expect(readFileSync(path.join(workspace, action), "utf8")).toBe(candidateAction);
        if (preflight && workflow !== "same") {
          // A different workflow revision stays with the pinned Actions checkout.
          expect(existsSync(harness)).toBe(false);
          return;
        }
        if (workflow === "same") {
          expect(existsSync(path.join(harness, ".git"))).toBe(false);
        }
        for (const [name, contents] of Object.entries(files)) {
          expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
        }
        for (const [name, contents] of Object.entries(evidenceScripts)) {
          expect(existsSync(path.join(harness, name))).toBe(workflowOwnsEvidence);
          if (workflowOwnsEvidence) {
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
          }
        }
        for (const [name, contents] of Object.entries(releasePolicy)) {
          expect(existsSync(path.join(harness, name))).toBe(preflight);
          if (preflight) {
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
            writeFileSync(path.join(workspace, name), "throw new Error('candidate policy');\n");
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
          }
        }
        if (posix) {
          // Git tracks only executable state; checkout materialization applies the process umask.
          expect(statSync(path.join(harness, executable)).mode & 0o111).not.toBe(0);
          expect(readlinkSync(path.join(harness, link))).toBe("line\nbreak.sh");
        }
        if (workflow !== "same" && workflowOwnsEvidence) {
          expect(report.commands.find(({ args }) => args[0] === "sparse-checkout")?.args).toEqual([
            "sparse-checkout",
            "set",
            "--no-cone",
            "/.github/actions/",
            "/scripts/ios-screenshot-evidence.mjs",
            "/scripts/lib/direct-run.mjs",
          ]);
        }
        writeFileSync(path.join(workspace, action), "later candidate edit\n");
        expect(readFileSync(path.join(harness, action), "utf8")).toBe(files[action]);
      },
    );
  },
  55_000,
);

registerWindowsCensusTests();

it.each(["prepare", "inspect"])(
  "removes checkout artifacts after %s assertion failure",
  async (phase) => {
    let root: string | undefined;
    await expect(
      withCiCheckoutFixture(
        "early-leader-exit",
        (directory) => {
          root = directory;
          expect(phase, "injected prepare assertion").not.toBe("prepare");
          writeFileSync(path.join(directory, "checkout.sh"), "exit 0\n");
        },
        (report, result, stderr) => {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expectCiCheckoutCleanup(report);
          expect(report.code, "injected inspect assertion").toBe(99);
        },
      ),
    ).rejects.toThrow(`injected ${phase} assertion`);
    expect(existsSync(expectDefined(root, "created checkout root"))).toBe(false);
  },
  55_000,
);

it.skipIf(process.platform === "win32").each(["census", "corrupt-report", "timeout"])(
  "retains checkout artifacts across failed outer-runner cleanup (%s)",
  async (fault) => {
    const preload = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
if (process.argv[2] === "sentinel" && fault === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (process.argv[2] === "supervise") {
  const root = process.argv[3], children = [], pending = new Set();
  const spawn = cp.spawn, spawnSync = cp.spawnSync, renameSync = fs.renameSync;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child.pid);
    pending.add(child);
    fs.writeFileSync(path.join(root, "creator-pids.json"), JSON.stringify([process.pid, ...children]));
    child.once("close", () => pending.delete(child));
    if (fault === "timeout") {
      // Notify after spawn returns and the fixture installs direct-child tracking.
      // Flush IPC before stalling; sentinel registration is deliberately blocked.
      queueMicrotask(() => {
        process.send({ type: "ci-checkout:sentinel-created", pids: [process.pid, child.pid] }, error => {
          if (error) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      });
    }
    return child;
  };
  cp.spawnSync = (...args) => {
    if (fault === "census" && args[0] === "/bin/ps" && children.length === 2 && pending.size === 0) {
      fs.writeFileSync(path.join(root, "closed-before-census.json"), JSON.stringify(children));
      throw new Error("injected final census failure after direct child close");
    }
    return spawnSync(...args);
  };
  fs.renameSync = (...args) => {
    const result = renameSync(...args);
    if (fault === "corrupt-report" && args[1] === path.join(root, "report.json")) {
      fs.writeFileSync(args[1], "null");
    }
    return result;
  };
  syncBuiltinESMExports();
}
`;
    // Use the actual outer namespace owner, including its cleanup on exit code 1.
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
const timeoutFault = process.argv[2] === "timeout";
let root, failure;
let supervisor, ready, onReady;
const fork = cp.fork;
if (timeoutFault) {
  ready = new Promise(resolve => {
    onReady = message => {
      if (message?.type === "ci-checkout:sentinel-created") resolve(message.pids);
    };
  });
  cp.fork = (...args) => {
    supervisor = fork(...args);
    supervisor.on("message", onReady);
    return supervisor;
  };
  syncBuiltinESMExports();
}
try {
  const { withCiCheckoutFixture } = await import(process.argv[1]);
  if (timeoutFault) mock.timers.enable({ apis: ["setTimeout"] });
  const completed = withCiCheckoutFixture("early-leader-exit", directory => {
    root = directory;
    fs.writeFileSync(path.join(root, "checkout.sh"), "exit 0\n");
    const preload = path.join(root, "fault.mjs");
    fs.writeFileSync(preload, "const fault = " + JSON.stringify(process.argv[2]) + ";\n" + process.argv[3]);
    return { NODE_OPTIONS: "--import=" + pathToFileURL(preload).href };
  }, (report, result, stderr) => {
    throw new Error("unexpected completed report: " + JSON.stringify({ report, result, stderr }));
  }).catch(error => {
    console.error(error);
    failure = String(error);
  });
  try {
    if (timeoutFault) {
      const pids = await Promise.race([ready, completed.then(() => {
        throw new Error("supervisor completed before the timeout probe was ready");
      })]);
      assert.equal(pids.length, 2);
      assert.equal(pids[0], supervisor.pid);
      assert.notEqual(pids[1], supervisor.pid);
      for (const pid of pids) {
        assert(Number.isInteger(pid) && pid > 1);
        process.kill(pid, 0);
      }
    }
  } finally {
    if (timeoutFault) {
      // Creation belongs to the supervisor, not a child's delayed self-registration.
      // Restore timers before the expired controller deadline starts real cleanup.
      mock.timers.tick(50_000);
      mock.timers.reset();
    }
    await completed;
  }
} catch (error) {
  console.error(error);
  failure = String(error);
} finally {
  if (timeoutFault) {
    mock.timers.reset();
    supervisor?.off("message", onReady);
    cp.fork = fork;
    syncBuiltinESMExports();
  }
}
console.log(JSON.stringify({ root, outerRoot: tmpdir(), failure,
  pids: JSON.parse(fs.readFileSync(path.join(root, "creator-pids.json"), "utf8")),
  closedBeforeCensus: fs.existsSync(path.join(root, "closed-before-census.json")),
}));
process.exitCode = 1;
`,
        new URL("./ci-checkout.test-support.ts", import.meta.url).href,
        fault,
        preload,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    const result = await completion;
    expect(stdout, stderr).not.toBe("");
    const evidence = JSON.parse(stdout) as {
      root: string;
      outerRoot: string;
      failure: string;
      pids: number[];
      closedBeforeCensus: boolean;
    };
    try {
      console.log(`${fault}: ${JSON.stringify({ result, ...evidence, stderr })}`);
      expect(result, stderr).toEqual({ code: 1, signal: null });
      expect(existsSync(evidence.outerRoot), "outer runner did not remove its own namespace").toBe(
        false,
      );
      expect(path.dirname(evidence.root)).toBe(
        realpathSync(fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url))),
      );
      expect(existsSync(evidence.root), stderr).toBe(true);
      expect(
        evidence.pids.every((pid) => !isProcessAlive(pid)),
        "fixture left owned processes alive",
      ).toBe(true);
      expect(stderr).toContain(
        `Checkout fixture retained at ${evidence.root}; no completed report.`,
      );
      expect(stderr).toContain("Supervisor close: true; group extinction: true.");
      if (fault === "census") {
        expect(evidence.closedBeforeCensus).toBe(true);
        expect(evidence.pids).toHaveLength(3);
        expect(stderr).toContain("injected final census failure after direct child close");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "timeout") {
        expect(evidence.pids).toHaveLength(2);
        expect(evidence.failure).toContain("did not close within 50000ms");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else {
        expect(evidence.failure).not.toContain("unexpected completed report");
        expect(readFileSync(path.join(evidence.root, "report.json"), "utf8")).toBe("null");
      }
    } finally {
      await Promise.all(evidence.pids.map((pid) => waitForDead(pid, 4_000)));
      rmSync(evidence.root, { recursive: true, force: true });
    }
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "waits for legal slow tree startup before cancellation",
  async () => {
    const report = await runCiGitStep({
      job: "checks-windows",
      env: { CHECKOUT_KIND: "platform" },
      fetchResults: ["hang"],
      scenario: "cancel-SIGTERM",
      startupDelay: { tree: 4_100 },
    });
    expect(report.code, report.output).toBe(143);
    expect(report.readyAttempts).toEqual([1]);
    expect(report.fetches).toHaveLength(1);
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "reports owner exit and output instead of a cleanup readiness timeout",
  async () => {
    const report = await runCiGitStep({
      policy: 'print("owner exited before cleanup readiness", flush=True)\nraise SystemExit(23)\n',
      fetchResults: [],
      cancelDuringCleanup: true,
    });
    expect(report.code).toBe(23);
    expect(report.cancelledDuringCleanup).toBe(false);
    expect(report.output).toBe("owner exited before cleanup readiness\n");
    expect(report.readyAttempts).toEqual([]);
    expect(report.commands).toEqual([]);
  },
  55_000,
);

it("does not revive a terminated fixture instance when its PID is reused", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import contextlib, json, os, pathlib, runpy, subprocess, sys, tempfile

with tempfile.TemporaryDirectory(prefix="checkout-pid-reuse-") as directory:
    root = pathlib.Path(directory).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    records = root / "pids"
    records.mkdir()
    (root / "lease").write_text("owned")
    # Guard command scope while retaining the real OS liveness result.
    guard = root / "census.cjs"
    guard.write_text('''
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spawnSync = cp.spawnSync;
const inspected = new Set();
cp.spawnSync = (command, args, options) => {
  if (command === "/bin/ps") {
    const index = args.indexOf("-p");
    assert(index >= 0 && args.filter(arg => arg === "-p").length === 1 && /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(args[index + 1]), "fixture census must query an explicit PID list");
    const selected = args[index + 1].split(",").map(Number);
    assert(process.platform === "linux" || selected.length === 1, "non-Linux census must query exactly one PID");
    assert(args.every(arg => !arg.startsWith("-") || ["-p", "-o"].includes(arg)), "fixture census must select owned PIDs only");
    const records = path.join(process.argv[3], "pids");
    const allowed = new Set(fs.readdirSync(records).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(records, name), "utf8"))).filter(record => !fs.existsSync(path.join(records, record.instance + ".dead"))).map(record => record.pid));
    for (const pid of selected) {
      assert(allowed.has(pid) && !inspected.has(pid), "fixture census escaped deduplicated registered ownership");
      inspected.add(pid);
    }
  }
  return spawnSync(command, args, options);
};
require("node:module").syncBuiltinESMExports();
''')
    with subprocess.Popen([sys.executable, "-I", "-S", "-c", "import sys; sys.stdin.read()"],
                          stdin=subprocess.PIPE) as child, contextlib.ExitStack() as cleanup:
        if os.name == "nt":
            broker = cleanup.enter_context(subprocess.Popen([
                sys.argv[1], "--input-type=module", "-e", """
const { createWindowsProcessCensus } = await import(process.argv[1]);
const owner = createWindowsProcessCensus({ root: process.argv[2], token: "owned",
  onFailure: error => { console.error(error); process.exitCode = 1; void owner.close(); } });
try {
  await owner.ready;
  console.log("ready");
  await new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
} finally { await owner.close(); }
""", sys.argv[4], str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
            # EOF retires the broker and sampler before the Python namespace owner leaves.
            cleanup.callback(lambda: broker.communicate(timeout=4))
            assert broker.stdout.readline().strip() == "ready", "census owner failed to initialize"
        retired = dict(pid=child.pid, role="grandchild", attempt=1, instance="retired")
        current = dict(pid=os.getpid(), role="grandchild", attempt=2, instance="current")
        if os.name == "nt":
            read_processes = runpy.run_path(sys.argv[3])["read_processes"]
            identities = read_processes([child.pid, os.getpid()])
            assert all(identity["alive"] for identity in identities)
            retired["creationTime"], current["creationTime"] = (
                identity["creationTime"] for identity in identities)
        child.communicate(timeout=10)
        (records / "retired.json").write_text(json.dumps(retired))
        (records / "current.json").write_text(json.dumps(current))
        (records / "sentinel.json").write_text(json.dumps(
            dict(current, role="sentinel", attempt=0, instance="sentinel")))

        def observe():
            subprocess.run([sys.argv[1], "--require", str(guard), sys.argv[2], "git", str(root), "early-leader-exit",
                            "-C", str(workspace), "checkout"], cwd=workspace, check=True)
            observed = json.loads((root / "events.jsonl").read_text().splitlines()[-1])
            assert observed["sentinelAlive"], "unrelated live sentinel was lost"
            return observed["alive"]

        assert observe() == [current], "first boundary must observe real child termination"
        # Fault-inject PID reuse only after actual death was observed. The fresh
        # instance at that live PID must remain visible, never hidden by retirement.
        retired["pid"] = current["pid"]
        (records / "retired.json").write_text(json.dumps(retired))
        assert observe() == [current], "a retired instance was revived by a reused PID"
        if os.name == "nt":
            # No death receipt exists for this instance: birth identity must
            # reject reuse even when no census observed the PID between lives.
            (records / "unobserved.json").write_text(json.dumps(
                dict(retired, instance="unobserved")))
            assert observe() == [current], "an unobserved retired birth was revived by PID reuse"
print("fixture lifetime contract passed")
`,
      process.execPath,
      ciCheckoutFixture,
      fileURLToPath(new URL("./fixtures/ci-windows-process-census.py", import.meta.url)),
      new URL("./fixtures/ci-windows-process-census.mjs", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("fixture lifetime contract passed");
});

it.skipIf(process.platform === "win32")(
  "recognizes terminated POSIX groups without accepting live signal denials",
  () => {
    const owner = readFileSync(".github/actions/git-owner/owner.py", "utf8");
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        String.raw`
import ast, contextlib, errno, io, json, os, pathlib, re, signal, subprocess, sys, tempfile, time

# Load only the actual boundary functions; never execute checkout or real Git.
functions = [node for node in ast.parse(sys.stdin.read()).body
             if isinstance(node, ast.FunctionDef) and node.name in ("group_alive", "group_signal")]
assert len(functions) == 2
exec(compile(ast.Module(body=functions, type_ignores=[]), "checkout-owner.py", "exec"))

# Retain the Popen handle without polling, so the owned zombie cannot be reaped or reused.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", "pass"], start_new_session=True) as child:
    deadline = time.monotonic() + 10
    while True:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(child.pid)],
                               check=True, capture_output=True, text=True).stdout.strip()
        if state.startswith("Z"):
            break
        assert time.monotonic() < deadline, "owned child did not terminate"
        time.sleep(0.01)
    assert not group_alive(child.pid, deadline), "zombies are terminated, not checkout writers"
    group_signal(child.pid, signal.SIGTERM, deadline)
    group_signal(child.pid, signal.SIGKILL, deadline)
    with tempfile.TemporaryDirectory(prefix="checkout-zombie-") as directory:
        root = pathlib.Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "pids").mkdir()
        (root / "lease").write_text("owned")
        for pid, role, attempt in [(child.pid, "grandchild", 1), (os.getpid(), "sentinel", 0)]:
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(pid=pid, role=role, attempt=attempt, instance=str(pid))))
        subprocess.run([sys.argv[1], sys.argv[2], "git", str(root), "early-leader-exit",
                        "-C", str(root / "workspace"), "checkout"], cwd=root / "workspace", check=True)
        observed = json.loads((root / "events.jsonl").read_text())
        assert observed["alive"] == [], "fixture counted a terminated zombie as a live writer"
        assert observed["sentinelAlive"]

# Reap the session/group leader while its real descendant still owns the pipe.
# A PID-only query or Darwin's legacy -g must not lose that remaining writer.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", """
import os, sys
if os.fork():
    os._exit(0)
print(os.getpid(), os.getpgrp(), os.getsid(0), flush=True)
sys.stdin.read()
"""], start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
    descendant, pgid, sid = map(int, child.stdout.readline().split())
    assert descendant != child.pid and pgid == sid == child.pid
    child.wait(timeout=2)
    actual_run = subprocess.run
    command_mode = os.environ.get("COMMAND_MODE")
    def scoped_census(command, **options):
        assert "-g" in command and command[command.index("-g") + 1] == str(pgid), "owner census must select its owned group/session"
        assert not set(command) & {"-a", "-A", "-e", "-x", "-axo", "-p"}, "owner census broadened or lost descendants"
        result = actual_run(command, **options)
        assert result.returncode == 0 and result.stderr == ""
        assert [int(line.split()[0]) for line in result.stdout.splitlines()] == [pgid]
        return result
    try:
        subprocess.run = scoped_census
        for mode in ("legacy", "unix2003"):
            os.environ["COMMAND_MODE"] = mode
            assert group_alive(pgid, time.monotonic() + 2), "reaped leader hid a live descendant"
            assert os.environ["COMMAND_MODE"] == mode, "query changed its owner's environment"
    finally:
        subprocess.run = actual_run
        if command_mode is None:
            os.environ.pop("COMMAND_MODE", None)
        else:
            os.environ["COMMAND_MODE"] = command_mode
        child.communicate(timeout=2)
    deadline = time.monotonic() + 2
    while group_alive(pgid, deadline):
        assert time.monotonic() < deadline, "descendant survived pipe closure"
        time.sleep(0.01)

# A denied signal is safe to normalize only if the same census proves extinction.
with subprocess.Popen([sys.executable, "-I", "-S", "-c",
                       "import sys; print('ready', flush=True); sys.stdin.read()"],
                      start_new_session=True, stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, text=True) as child:
    assert child.stdout.readline().strip() == "ready"
    actual_killpg = os.killpg
    def denied(pgid, signum):
        assert pgid == child.pid and signum in (0, signal.SIGTERM)
        raise PermissionError(errno.EPERM, "test-owned signal denial")
    actual_run = subprocess.run
    try:
        for probe in (actual_killpg, denied):
            os.killpg = probe
            for code, output, diagnostic in [
                (1, "", ""), (0, "", ""), (0, " \n", ""), (2, "", ""), (-9, "", ""),
                (1, f"{child.pid} Z\n", ""),
                (0, f"{child.pid} Z\n", "injected census diagnostic\n"),
                (1, "", "injected census diagnostic\n"),
                ("timeout", "", "injected census diagnostic\n"),
                (0, f"{child.pid} Z\nbroken\n", ""),
                (0, f"{child.pid} S\nbroken\n", ""),
                (0, f"{child.pid} Z", ""),
                (0, f"{os.getpgrp()} S\n", ""),
                (0, "invalid Z\n", ""),
                (0, f"{child.pid} Zbogus\n", ""),
                (0, f"{child.pid} Z extra\n", ""),
            ]:
                def census_result(command, **options):
                    if code == "timeout":
                        raise subprocess.TimeoutExpired(command, options["timeout"], stderr=diagnostic.encode())
                    result = subprocess.CompletedProcess(command, code, output, diagnostic)
                    if options.get("check"):
                        result.check_returncode()
                    return result
                subprocess.run = census_result
                captured = io.StringIO()
                with contextlib.redirect_stderr(captured):
                    try:
                        group_alive(child.pid, time.monotonic() + 2)
                    except (RuntimeError, ValueError, PermissionError, subprocess.SubprocessError):
                        pass
                    else:
                        raise AssertionError(f"ambiguous census accepted: {(code, output, diagnostic)!r}")
                assert captured.getvalue() == diagnostic, "census lost its diagnostic"
    finally:
        subprocess.run = actual_run
        os.killpg = actual_killpg
    os.killpg = denied
    try:
        try:
            group_signal(child.pid, signal.SIGTERM, time.monotonic() + 10)
        except PermissionError:
            pass
        else:
            raise AssertionError("live denied group was accepted as terminated")
    finally:
        os.killpg = actual_killpg
    # Force the real probe/query race: the group exists at killpg(0), then exits
    # before native ps selects it. Only the subsequent native ESRCH proves absence.
    def census_after_exit(command, **options):
        child.communicate(timeout=2)
        result = actual_run(command, **options)
        assert result.returncode == 1 and result.stdout == result.stderr == ""
        return result
    try:
        subprocess.run = census_after_exit
        assert not group_alive(child.pid, time.monotonic() + 2)
    finally:
        subprocess.run = actual_run
print("group contract passed")
`,
        process.execPath,
        ciCheckoutFixture,
      ],
      { input: owner, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group contract passed");
  },
);

const diagnosticSecret = "synthetic-diagnostic-secret";
const diagnosticPrefix = "[ci-git-owner] diagnostic=";

function runOwnerDiagnostic(policy: string) {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", path.resolve(".github/actions/git-owner/owner.py"), "--policy", "-"],
    {
      input: `import ci_git_owner as owner, os, sys
secret = ${JSON.stringify(diagnosticSecret)}
sys.argv.append(secret)
os.environ["OWNER_DIAGNOSTIC_SECRET"] = secret
${policy}`,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(125);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(diagnosticSecret);
  expect(result.stderr).not.toContain(process.cwd());
  expect(result.stderr).not.toContain("Traceback");
  const lines = result.stderr.trim().split(/\r?\n/u);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(
    /^::error::Git ownership\/setup failed \([A-Za-z]+\); refusing reuse or retry$/u,
  );
  expect(lines[1]?.startsWith(diagnosticPrefix)).toBe(true);
  expect(result.stderr.length).toBeLessThan(4_096);
  return { annotation: lines[0], diagnostic: lines[1]!.slice(diagnosticPrefix.length) };
}

it.each([
  { scenario: "direct denial", setup: "", types: ["PermissionError"] },
  {
    scenario: "timeout context",
    setup: "error.__context__ = owner.FetchTimeout()",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "explicit cause before context",
    setup: "error.__cause__ = owner.FetchTimeout()\nerror.__context__ = ValueError(secret)",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "cyclic context",
    setup: "error.__context__ = error",
    types: ["PermissionError"],
  },
  {
    scenario: "bounded context",
    setup:
      "cursor = error\nfor _ in range(8):\n    cursor.__context__ = RuntimeError(secret)\n    cursor = cursor.__context__",
    types: ["PermissionError", "RuntimeError", "RuntimeError", "RuntimeError"],
  },
])("retains bounded terminal diagnostics: $scenario", ({ scenario, setup, types }) => {
  const { diagnostic } = runOwnerDiagnostic(`
error = PermissionError(13, secret, secret + "/private-path")
error.winerror = 5
${setup}
raise error
`);
  const chain = JSON.parse(diagnostic) as { type: string; via: string; owner_frames: unknown[] }[];
  expect(chain.map((record) => record.type)).toEqual(types);
  expect(chain.map((record) => record.via)).toEqual([
    "terminal",
    ...types.slice(1).map(() => (scenario.startsWith("explicit") ? "cause" : "context")),
  ]);
  expect(chain[0]).toEqual({
    type: "PermissionError",
    via: "terminal",
    errno: 13,
    winerror: 5,
    owner_frames: [
      { function: "<module>", line: expect.any(Number) },
      { function: "main", line: expect.any(Number) },
    ],
  });
  for (const record of chain.slice(1)) {
    expect(record).toEqual({ type: record.type, via: record.via, owner_frames: [] });
  }
});

it.each([
  { errno: "secret", winerror: "True" },
  { errno: "2 ** 100", winerror: "-(2 ** 100)" },
  { errno: "type('NumericSecret', (int,), {})(13)", winerror: "None" },
])("redacts terminal diagnostic metadata ($errno, $winerror)", ({ errno, winerror }) => {
  const { annotation, diagnostic } = runOwnerDiagnostic(`
error = type(secret, (Exception,), {"__module__": "builtins"})(secret)
error.errno, error.winerror = ${errno}, ${winerror}
# Even the owner's filename and globals cannot turn policy code into owner source.
owner.diagnostic_error = error
exec(compile("def synthetic_diagnostic_secret():\\n    raise diagnostic_error\\nsynthetic_diagnostic_secret()",
             owner.__file__, "exec"), vars(owner))
`);
  expect(annotation).toContain("(unknown)");
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "unknown",
      via: "terminal",
      owner_frames: [
        { function: "<module>", line: expect.any(Number) },
        { function: "main", line: expect.any(Number) },
      ],
    },
  ]);
});

it("bounds terminal diagnostics to the last six actual owner frames", () => {
  const { diagnostic } = runOwnerDiagnostic(`
import io, sys
owner.diagnostic_depth = 0
owner.diagnostic_policy = '''import ci_git_owner as owner, io, sys
owner.diagnostic_depth += 1
if owner.diagnostic_depth == 12:
    raise ValueError("synthetic-diagnostic-secret")
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
'''
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
`);
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "ValueError",
      via: "terminal",
      owner_frames: Array.from({ length: 6 }, () => ({
        function: "main",
        line: expect.any(Number),
      })),
    },
  ]);
});

it.each(
  ["raises", "malformed traceback"].flatMap((fault) =>
    [false, true].map((cyclic) => ({ fault, cyclic })),
  ),
)("keeps terminal exit 125 with $fault metadata (cyclic=$cyclic)", ({ fault, cyclic }) => {
  const { diagnostic } = runOwnerDiagnostic(`
class BrokenMetadata(Exception):
    def __getattribute__(self, name):
        if name == "errno" and ${JSON.stringify(fault)} == "raises":
            raise SystemExit(42)
        if name == "__traceback__" and ${JSON.stringify(fault)} == "malformed traceback":
            return self
        return super().__getattribute__(name)
error = BrokenMetadata(secret)
if ${cyclic ? "True" : "False"}:
    error.__context__ = error
raise error
`);
  expect(diagnostic).toBe("unavailable");
});

it.each([...(process.platform === "win32" ? ["setup"] : []), "launch", "timeout-drain"])(
  "distinguishes terminal diagnostic failure sites: %s",
  (site) => {
    const { diagnostic } = runOwnerDiagnostic(String.raw`
import os, shlex, subprocess, sys, tempfile
site = ${JSON.stringify(site)}
if os.name == "nt":
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    duplicate = kernel.DuplicateHandle
    duplicate.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
    duplicate.restype = w.BOOL
    current = kernel.GetCurrentProcess
    current.argtypes, current.restype = [], w.HANDLE
    def restricted_call(actual, rights, *args):
        handle = w.HANDLE()
        if not duplicate(current(), args[0], current(), c.byref(handle), rights, False, 0):
            raise c.WinError(c.get_last_error())
        try:
            return actual(handle, *args[1:])
        finally:
            owner.close_handle(handle)
    if site == "setup":
        actual = owner.set_job
        owner.set_job = lambda *args: restricted_call(actual, 0x4, *args)
    elif site == "timeout-drain":
        actual = owner.query_job
        owner.query_job = lambda *args: restricted_call(actual, 0x8, *args)
elif site == "timeout-drain":
    actual_drain = owner.drain
    def denied_drain(*args):
        actual_drain(*args)
        raise PermissionError(13, secret)
    owner.drain = denied_drain

# No files are created or removed after deliberately unverified Job cleanup.
directory = tempfile.gettempdir()
if site == "launch":
    actual_popen = subprocess.Popen
    def invalid_executable(*args, **kwargs):
        kwargs["executable"] = directory
        return actual_popen(*args, **kwargs)
    subprocess.Popen = invalid_executable
alias = "!" + shlex.join([sys.executable.replace("\\", "/"), "-I", "-S", "-c", "import time; time.sleep(30)"])
owner.run_git(directory, "-c", "alias.diagnostic=" + alias, "diagnostic", timeout=0.1,
              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
    const chain = JSON.parse(diagnostic) as {
      type: string;
      errno?: number;
      winerror?: number;
      owner_frames: { function: string; line: number }[];
    }[];
    expect(chain.map((record) => record.type)).toEqual(
      site === "timeout-drain"
        ? ["RuntimeError", "PermissionError", "FetchTimeout"]
        : ["PermissionError"],
    );
    const denial = expectDefined(
      chain.find((record) => record.type === "PermissionError"),
      "recorded permission denial",
    );
    expect(denial.errno).toBe(13);
    expect(denial.winerror).toBe(process.platform === "win32" ? 5 : undefined);
    expect(denial.owner_frames.map((frame) => frame.function)).toContain("run_git");
    expect(denial.owner_frames.some((frame) => frame.function === "drain")).toBe(
      process.platform === "win32" && site === "timeout-drain",
    );
    for (const frame of chain.flatMap((record) => record.owner_frames)) {
      expect(Number.isInteger(frame.line) && frame.line > 0).toBe(true);
      expect(["<module>", "main", "run_git", "drain"]).toContain(frame.function);
    }
  },
);
