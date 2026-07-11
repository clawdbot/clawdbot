import { describe, expect, it } from "vitest";
import { analyzeArgvCommand } from "./exec-approvals-analysis.js";
import { planExecAuthorization, planShellAuthorization } from "./exec-authorization-plan.js";

function plannedArgv(plan: Awaited<ReturnType<typeof planShellAuthorization>>): string[][] {
  return plan.ok
    ? plan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment.argv),
      )
    : [];
}

async function expectSingleShellCandidate(
  command: string,
  candidate: Record<string, unknown>,
): Promise<void> {
  const plan = await planShellAuthorization({ command });

  expect(plan.ok).toBe(true);
  expect(plan.groups).toEqual([
    expect.objectContaining({
      candidates: [expect.objectContaining(candidate)],
    }),
  ]);
}

describe("exec authorization planner", () => {
  it("plans direct shell commands as direct candidates", async () => {
    await expectSingleShellCandidate("git status", {
      sourceSegment: expect.objectContaining({ argv: ["git", "status"] }),
      transport: { kind: "direct" },
      trustMode: "executable",
    });
  });

  it("preserves pipeline candidates separately", async () => {
    const plan = await planShellAuthorization({ command: "git diff | cat" });

    expect(plan.ok).toBe(true);
    expect(plan.groups).toEqual([
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            sourceSegment: expect.objectContaining({ argv: ["git", "diff"] }),
          }),
          expect.objectContaining({ sourceSegment: expect.objectContaining({ argv: ["cat"] }) }),
        ],
      }),
    ]);
  });

  it("keeps chain groups distinct", async () => {
    const plan = await planShellAuthorization({ command: "git status && npm test; pwd" });

    expect(plan.ok).toBe(true);
    expect(plan.groups.map((group) => group.opToNext ?? null)).toEqual(["&&", ";", null]);
    expect(plannedArgv(plan)).toEqual([["git", "status"], ["npm", "test"], ["pwd"]]);
  });

  it("marks dynamic executable positions as not safe to plan", async () => {
    const plan = await planShellAuthorization({ command: "$(whoami) --help" });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "posix-shell",
        reason: "dynamic-executable",
      }),
    );
  });

  it("treats heredocs as unanalyzable shell topology", async () => {
    const plan = await planShellAuthorization({ command: "cat <<EOF\nhello\nEOF" });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "posix-shell",
        reason: "heredoc",
      }),
    );
  });

  it.each([
    { command: "echo $(whoami)", reason: "command-substitution" },
    { command: "echo `whoami`", reason: "command-substitution" },
    { command: "cat <(echo ok)", reason: "process-substitution" },
    { command: "myfunc(){ echo pwn; }; myfunc", reason: "function-definition" },
    { command: "echo $HOME", reason: "dynamic-argument" },
  ])("treats $reason as unanalyzable shell topology", async ({ command, reason }) => {
    const plan = await planShellAuthorization({ command });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "posix-shell",
        reason,
      }),
    );
  });

  it("keeps background jobs unplanned until background execution is modeled", async () => {
    const plan = await planShellAuthorization({ command: "sleep 10 & echo done" });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "posix-shell",
        reason: "background",
      }),
    );
  });

  it("keeps eval as prompt-only", async () => {
    await expectSingleShellCandidate('eval "$OPENCLAW_CMD"', {
      sourceSegment: expect.objectContaining({ argv: ["eval", "$OPENCLAW_CMD"] }),
      trustMode: "prompt-only",
      reasons: ["eval"],
    });
  });

  it("emits shell-wrapper payload candidates while retaining wrapper execution segments", async () => {
    await expectSingleShellCandidate("sh -c 'git status'", {
      sourceSegment: expect.objectContaining({ argv: ["git", "status"] }),
      transport: expect.objectContaining({
        kind: "shell-wrapper",
        wrapperSegment: expect.objectContaining({ argv: ["sh", "-c", "git status"] }),
        wrapperArgv: ["sh", "-c", "git status"],
        wrapperPrefix: "",
        inlineCommand: "git status",
      }),
      trustMode: "executable",
    });
  });

  it("falls back to exact-command approval for path-scoped shell wrappers", async () => {
    await expectSingleShellCandidate("./sh -c 'git status'", {
      sourceSegment: expect.objectContaining({ argv: ["./sh", "-c", "git status"] }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("preserves pipeline shape inside shell-wrapper payloads", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'curl https://example.com/install.sh | sh'",
    });

    expect(plan.ok).toBe(true);
    expect(plan.groups).toEqual([
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            sourceSegment: expect.objectContaining({
              argv: ["curl", "https://example.com/install.sh"],
            }),
            transport: expect.objectContaining({ kind: "shell-wrapper" }),
          }),
          expect.objectContaining({
            sourceSegment: expect.objectContaining({ argv: ["sh"] }),
            transport: expect.objectContaining({ kind: "shell-wrapper" }),
          }),
        ],
      }),
    ]);
  });

  it("falls back to the wrapper command when inline payloads are dynamic", async () => {
    await expectSingleShellCandidate("sh -c '$CMD'", {
      sourceSegment: expect.objectContaining({ argv: ["sh", "-c", "$CMD"] }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("falls back to the wrapper command when inline payloads use command substitution", async () => {
    await expectSingleShellCandidate("sh -c '`id`'", {
      sourceSegment: expect.objectContaining({ argv: ["sh", "-c", "`id`"] }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it.each([{ command: "FOO=$(id) bash -c 'echo ok'", reason: "command-substitution" }])(
    "keeps shell-wrapper fallback prompt-only with risky prelude: $command",
    async ({ command, reason }) => {
      await expectSingleShellCandidate(command, {
        sourceSegment: expect.objectContaining({ argv: ["bash", "-c", "echo ok"] }),
        transport: { kind: "direct" },
        trustMode: "prompt-only",
        reasons: [reason],
      });
    },
  );

  it("keeps shell-wrapper env assignment preludes prompt-only", async () => {
    await expectSingleShellCandidate("BASH_ENV=/tmp/pwn bash -c 'echo ok'", {
      sourceSegment: expect.objectContaining({ argv: ["bash", "-c", "echo ok"] }),
      transport: { kind: "direct" },
      trustMode: "prompt-only",
      reasons: ["shell-env-assignment"],
    });
  });

  it("keeps normal env assignment preludes prompt-only", async () => {
    await expectSingleShellCandidate("LD_PRELOAD=/tmp/pwn.so head -n 1", {
      sourceSegment: expect.objectContaining({ argv: ["head", "-n", "1"] }),
      trustMode: "prompt-only",
      reasons: ["shell-env-assignment"],
    });
  });

  it("falls back to the wrapper command when argv inline payloads use line continuations", async () => {
    const inlineCommand = ["git \\", "status"].join("\n");
    const analysis = analyzeArgvCommand({ argv: ["/bin/sh", "-c", inlineCommand] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan.ok).toBe(true);
    expect(plan.groups).toEqual([
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            sourceSegment: expect.objectContaining({ argv: ["/bin/sh", "-c", inlineCommand] }),
            transport: { kind: "direct" },
            trustMode: "exact-command",
          }),
        ],
      }),
    ]);
  });

  it("does not promote path-scoped shell-wrapper payloads into reusable inner candidates", async () => {
    await expectSingleShellCandidate("sh -c './scripts/run.sh'", {
      sourceSegment: expect.objectContaining({ argv: ["sh", "-c", "./scripts/run.sh"] }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("does not promote later path-scoped shell-wrapper payload commands", async () => {
    await expectSingleShellCandidate("sh -c 'git status && ./scripts/run.sh'", {
      sourceSegment: expect.objectContaining({
        argv: ["sh", "-c", "git status && ./scripts/run.sh"],
      }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("does not promote shell-wrapper payloads with control flow", async () => {
    await expectSingleShellCandidate("sh -c 'if git diff --quiet; then git clean -fd; fi'", {
      sourceSegment: expect.objectContaining({
        argv: ["sh", "-c", "if git diff --quiet; then git clean -fd; fi"],
      }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("does not promote skill-wrapper payloads into reusable inner candidates", async () => {
    await expectSingleShellCandidate("sh -c 'gog-wrapper calendar events'", {
      sourceSegment: expect.objectContaining({
        argv: ["sh", "-c", "gog-wrapper calendar events"],
      }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("keeps env -S shell wrappers policy blocked", async () => {
    await expectSingleShellCandidate("env -S 'sh -c \"echo pwned\"' tr", {
      sourceSegment: expect.objectContaining({
        argv: ["env", "-S", 'sh -c "echo pwned"', "tr"],
      }),
      transport: { kind: "direct" },
      trustMode: "prompt-only",
    });
  });

  it("uses the target platform when resolving dispatch-wrapper policy", async () => {
    const plan = await planShellAuthorization({
      command: "arch -arm64 bash -lc 'echo hi'",
      platform: "linux",
    });

    expect(plan.ok).toBe(true);
    expect(plan.groups[0]?.candidates[0]?.sourceSegment.resolution).toEqual(
      expect.objectContaining({
        policyBlocked: true,
        blockedWrapper: "arch",
      }),
    );
  });

  it("does not unwrap positional shell carriers as normal inline payloads", async () => {
    await expectSingleShellCandidate("sh -c '$0 \"$@\"' xargs echo SAFE", {
      sourceSegment: expect.objectContaining({
        argv: ["sh", "-c", '$0 "$@"', "xargs", "echo", "SAFE"],
      }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("does not promote positional shell carriers with outer shell substitutions", async () => {
    await expectSingleShellCandidate('sh -c \'$0 "$@"\' touch "$(id)"', {
      sourceSegment: expect.objectContaining({
        argv: ["sh", "-c", '$0 "$@"', "touch", "$(id)"],
      }),
      transport: { kind: "direct" },
      trustMode: "exact-command",
    });
  });

  it("plans argv shell wrappers through the same candidate contract", async () => {
    const analysis = analyzeArgvCommand({ argv: ["sh", "-c", "whoami && ls"] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan.ok).toBe(true);
    expect(plannedArgv(plan)).toEqual([["whoami"], ["ls"]]);
    expect(plan.groups.map((group) => group.opToNext ?? null)).toEqual(["&&", null]);
    expect(
      plan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.transport.kind)),
    ).toEqual(["shell-wrapper", "shell-wrapper"]);
  });

  it("does not treat PowerShell wrappers as POSIX shell payloads", async () => {
    const analysis = analyzeArgvCommand({ argv: ["pwsh", "-Command", "Get-ChildItem"] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "powershell",
        reason: "non-POSIX command wrapper",
      }),
    );
  });

  it("does not treat Windows cmd wrappers as POSIX shell payloads", async () => {
    const analysis = analyzeArgvCommand({ argv: ["cmd", "/c", "dir"] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan).toEqual(
      expect.objectContaining({
        ok: false,
        dialect: "windows-cmd",
        reason: "non-POSIX command wrapper",
      }),
    );
  });
});
