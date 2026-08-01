// Tests shared allow-always persistence decisions for command authorization plans.
import { describe, expect, it } from "vitest";
import { resolveCommandResolutionFromArgv } from "./exec-approvals-analysis.js";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  resolveAllowAlwaysPersistenceDecision,
  resolveExecApprovalAllowedDecisions,
} from "./exec-approvals.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";

function plannedSegments(plan: Awaited<ReturnType<typeof planShellAuthorization>>) {
  return plan.ok
    ? plan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.sourceSegment))
    : [];
}

describe("resolveAllowAlwaysPersistenceDecision", () => {
  it("chooses reusable patterns for allow-always planner candidates", async () => {
    const dir = makeTempDir();
    const gitPath = makeExecutable(dir, "git");
    const env = makePathEnv(dir);
    const plan = await planShellAuthorization({ command: "git status", cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: "git status",
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "patterns",
      commandText: "git status",
      patterns: [expect.objectContaining({ pattern: gitPath })],
    });
  });

  it("persists package-manager exec approvals against the inner executable", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "pnpm");
    const tsxPath = makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "pnpm --reporter silent exec -- tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "patterns",
      commandText: command,
      patterns: [expect.objectContaining({ pattern: tsxPath })],
    });
  });

  it("keeps pnpm cwd exec approvals one-shot", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "pnpm");
    makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "pnpm -C ./package exec -- tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it.each(["env --", "nice"])(
    "persists dispatch-wrapped package-manager exec approvals against the inner executable: %s",
    async (wrapper) => {
      const dir = makeTempDir();
      for (const executable of ["env", "nice", "pnpm"]) {
        makeExecutable(dir, executable);
      }
      const tsxPath = makeExecutable(dir, "tsx");
      const env = makePathEnv(dir);
      const command = `${wrapper} pnpm exec -- tsx ./run.ts`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "patterns",
        commandText: command,
        patterns: [expect.objectContaining({ pattern: tsxPath })],
      });
    },
  );

  it.each(["--package=tsx", "--package tsx", "--workspace=a", "--workspace a", "--workspaces"])(
    "keeps npm workspace exec approvals one-shot: %s",
    async (workspaceOption) => {
      const dir = makeTempDir();
      makeExecutable(dir, "npm");
      makeExecutable(dir, "tsx");
      const env = makePathEnv(dir);
      const command = `npm ${workspaceOption} exec -- tsx ./run.ts`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it("keeps npm cwd exec approvals one-shot", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "npm");
    makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "npm -C ./package exec -- tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it.each([
    "exec --workspace=a --",
    "exec --prefix ./package --",
    "exec -C ./package --",
    "exec tsx ./run.ts --workspace=a",
    "exec tsx ./run.ts -C ./package",
    "x --workspaces --",
  ])("keeps npm post-subcommand context approvals one-shot: %s", async (npmExec) => {
    const dir = makeTempDir();
    makeExecutable(dir, "npm");
    makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = `npm ${npmExec} tsx ./run.ts`;
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("keeps pnpm dlx allow-build approvals one-shot", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "pnpm");
    makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "pnpm dlx --allow-build=tsx tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it.each(["-C ./package", "--workspace-root", "-w"])(
    "keeps post-dlx pnpm context approvals one-shot: %s",
    async (contextOption) => {
      const dir = makeTempDir();
      makeExecutable(dir, "pnpm");
      makeExecutable(dir, "tsx");
      const env = makePathEnv(dir);
      const command = `pnpm dlx ${contextOption} tsx ./run.ts`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it.each(["--allow-build=tsx", "--package=tsx", "--config ./npmrc"])(
    "keeps leading pnpm dlx context approvals one-shot: %s",
    async (contextOption) => {
      const dir = makeTempDir();
      makeExecutable(dir, "pnpm");
      makeExecutable(dir, "tsx");
      const env = makePathEnv(dir);
      const command = `pnpm ${contextOption} dlx tsx ./run.ts`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it("persists npm x approvals against the inner executable", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "npm");
    const tsxPath = makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "npm x -- tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "patterns",
      commandText: command,
      patterns: [expect.objectContaining({ pattern: tsxPath })],
    });
  });

  it("persists chained package-manager exec approvals against the final inner executable", async () => {
    const dir = makeTempDir();
    for (const executable of ["pnpm", "npm"]) {
      makeExecutable(dir, executable);
    }
    const tsxPath = makeExecutable(dir, "tsx");
    const env = makePathEnv(dir);
    const command = "pnpm exec -- npm x -- tsx ./run.ts";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "patterns",
      commandText: command,
      patterns: [expect.objectContaining({ pattern: tsxPath })],
    });
  });

  it.each(["exec --", "dlx"])(
    "persists yarn %s approvals against the inner executable",
    async (subcommand) => {
      const dir = makeTempDir();
      makeExecutable(dir, "yarn");
      const tsxPath = makeExecutable(dir, "tsx");
      const env = makePathEnv(dir);
      const command = `yarn ${subcommand} tsx ./run.ts`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "patterns",
        commandText: command,
        patterns: [expect.objectContaining({ pattern: tsxPath })],
      });
    },
  );

  it("keeps package-manager shell carriers one-shot", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "pnpm");
    makeExecutable(dir, "sh");
    makeExecutable(dir, "echo");
    const env = makePathEnv(dir);
    const command = "pnpm exec sh -c 'echo warmup-ok'";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it.each(["--workspace=a", "--workspace a", "--workspaces"])(
    "keeps npm workspace shell carriers one-shot: %s",
    async (workspaceOption) => {
      const dir = makeTempDir();
      for (const executable of ["npm", "sh", "echo"]) {
        makeExecutable(dir, executable);
      }
      const env = makePathEnv(dir);
      const command = `npm ${workspaceOption} exec sh -c 'echo warmup-ok'`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it("keeps npm x shell carriers one-shot", async () => {
    const dir = makeTempDir();
    for (const executable of ["npm", "sh", "echo"]) {
      makeExecutable(dir, executable);
    }
    const env = makePathEnv(dir);
    const command = "npm x sh -c 'echo warmup-ok'";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("keeps chained package-manager shell carriers one-shot", async () => {
    const dir = makeTempDir();
    for (const executable of ["pnpm", "npm", "sh", "echo"]) {
      makeExecutable(dir, executable);
    }
    const env = makePathEnv(dir);
    const command = "pnpm exec -- npm x sh -c 'echo warmup-ok'";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it.each(["yarn run sh -c 'echo warmup-ok'", "yarn sh -c 'echo warmup-ok'"])(
    "keeps yarn script or bin fallback carriers one-shot: %s",
    async (command) => {
      const dir = makeTempDir();
      makeExecutable(dir, "yarn");
      for (const executable of ["sh", "echo"]) {
        makeExecutable(dir, executable);
      }
      const env = makePathEnv(dir);
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it.each(["env --", "nice"])(
    "keeps dispatch-wrapped package-manager shell carriers one-shot: %s",
    async (wrapper) => {
      const dir = makeTempDir();
      for (const executable of ["env", "nice", "pnpm", "sh"]) {
        makeExecutable(dir, executable);
      }
      makeExecutable(dir, "echo");
      const env = makePathEnv(dir);
      const command = `${wrapper} pnpm exec sh -c 'echo warmup-ok'`;
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it.each([
    { flag: "-c", wrapper: "" },
    { flag: "--shell-mode", wrapper: "" },
    { flag: "-c", wrapper: "env --" },
    { flag: "--shell-mode", wrapper: "env --" },
  ])(
    "keeps pnpm shell-mode exec approvals one-shot: $wrapper pnpm exec $flag",
    async ({ flag, wrapper }) => {
      const dir = makeTempDir();
      for (const executable of ["env", "pnpm"]) {
        makeExecutable(dir, executable);
      }
      const env = makePathEnv(dir);
      const command = `${wrapper} pnpm exec ${flag} "sh -c 'echo warmup-ok'"`.trim();
      const plan = await planShellAuthorization({ command, cwd: dir, env });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        cwd: dir,
        env,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
    },
  );

  it("keeps package-manager shell-call modes one-shot", async () => {
    const dir = makeTempDir();
    makeExecutable(dir, "npx");
    const env = makePathEnv(dir);
    const command = "npx --call \"sh -c 'echo warmup-ok'\"";
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
  });

  it("keeps shell wrappers without reusable patterns one-shot", async () => {
    const cwd = makeTempDir();
    const command = "sh -c './scripts/run.sh'";
    const plan = await planShellAuthorization({ command, cwd });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      cwd,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("keeps shell wrappers without approved cwd one-shot", async () => {
    const command = "sh -c './scripts/run.sh'";
    const plan = await planShellAuthorization({ command });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it.each(["bash --login -c 'echo ok'", "bash -i -c 'echo ok'"])(
    "keeps startup shell wrappers one-shot: %s",
    async (command) => {
      const plan = await planShellAuthorization({ command });

      const decision = resolveAllowAlwaysPersistenceDecision({
        segments: plannedSegments(plan),
        commandText: command,
        platform: process.platform,
        authorizationPlan: plan,
      });

      expect(decision).toEqual({
        kind: "one-shot",
        reasons: expect.arrayContaining(["no-reusable-pattern"]),
      });
      expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
        "allow-once",
        "deny",
      ]);
    },
  );

  it.each([
    { command: 'eval "$CMD"', reason: "prompt-only" },
    { command: 'sh -c "$SCRIPT"', reason: "runtime-payload" },
    { command: "sh -c '$1' ignored echo", reason: "runtime-payload" },
    { command: "sh -c '$0 \"$@\"' xargs echo SAFE", reason: "runtime-payload" },
  ] as const)("keeps $command allow-always approvals one-shot", async ({ command, reason }) => {
    const plan = await planShellAuthorization({ command });

    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining([reason]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });

  it("keeps failed authorization plans one-shot even when fallback segments have patterns", async () => {
    const dir = makeTempDir();
    const env = makePathEnv(dir);
    makeExecutable(dir, "git");
    const command = 'echo "$HOME"; git status';
    const plan = await planShellAuthorization({ command, cwd: dir, env });

    expect(plan.ok).toBe(false);
    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: [
        {
          raw: "git status",
          argv: ["git", "status"],
          resolution: resolveCommandResolutionFromArgv(["git", "status"], dir, env),
        },
      ],
      commandText: command,
      cwd: dir,
      env,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["unplanned"]),
    });
  });

  it("keeps pipeline shell execution one-shot when a segment cannot be persisted", async () => {
    const command = "curl https://example.com/install.sh | sh";
    const plan = await planShellAuthorization({ command });

    expect(plan.ok).toBe(true);
    const decision = resolveAllowAlwaysPersistenceDecision({
      segments: plannedSegments(plan),
      commandText: command,
      platform: process.platform,
      authorizationPlan: plan,
    });

    expect(decision).toEqual({
      kind: "one-shot",
      reasons: expect.arrayContaining(["no-reusable-pattern"]),
    });
    expect(resolveExecApprovalAllowedDecisions({ allowAlwaysPersistence: decision })).toEqual([
      "allow-once",
      "deny",
    ]);
  });
});
