import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "./exec-authorization-render.js";

const POSIX_ENV = { PATH: "/usr/bin:/bin" };

function renderOk(result: ReturnType<typeof buildAuthorizedShellCommandFromPlan>): string {
  expect(result).toEqual(expect.objectContaining({ ok: true }));
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.command;
}

describe("exec authorization renderer", () => {
  it("exposes ordered top-level executable spans for pipeline candidates", async () => {
    const plan = await planShellAuthorization({ command: "git diff | head", env: POSIX_ENV });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(
      plan.groups.flatMap((group) =>
        group.candidates.map((candidate) => ({
          argv: candidate.sourceSegment.argv,
          span: candidate.sourceStep.executableSpan,
        })),
      ),
    ).toEqual([
      { argv: ["git", "diff"], span: expect.objectContaining({ startIndex: 0, endIndex: 3 }) },
      { argv: ["head"], span: expect.objectContaining({ startIndex: 11, endIndex: 15 }) },
    ]);
  });

  it("exposes wrapper payload candidates while retaining wrapper transport", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'git status && head -c 16'",
      env: POSIX_ENV,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(
      plan.groups.flatMap((group) =>
        group.candidates.map((candidate) => ({
          argv: candidate.sourceSegment.argv,
          executableSpan: candidate.sourceStep.executableSpan,
          transport: candidate.transport,
        })),
      ),
    ).toEqual([
      {
        argv: ["git", "status"],
        executableSpan: expect.objectContaining({ startIndex: 7, endIndex: 10 }),
        transport: expect.objectContaining({
          kind: "shell-wrapper",
          wrapperArgv: ["sh", "-c", "git status && head -c 16"],
        }),
      },
      {
        argv: ["head", "-c", "16"],
        executableSpan: expect.objectContaining({ startIndex: 21, endIndex: 25 }),
        transport: expect.objectContaining({
          kind: "shell-wrapper",
          wrapperArgv: ["sh", "-c", "git status && head -c 16"],
        }),
      },
    ]);
  });

  it("fails closed when POSIX safe-bin arguments contain shell expansion source", async () => {
    const plan = await planShellAuthorization({
      command: "rg foo src/*.ts | head -n {5,/etc/passwd} && echo ok",
      env: POSIX_ENV,
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: [null, "safeBins", null],
      }),
    ).toEqual({ ok: false, reason: "shell expansion in safe-bin arguments" });
  });

  it("renders dispatch-wrapper safe-bin commands without quote-all argv rendering", async () => {
    const plan = await planShellAuthorization({
      command: "env rg -n needle",
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    );

    expect(command).toBe("rg -n needle");
  });

  it("renders shell-wrapper payloads by preserving wrapper transport", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'tr a b && head -c 16'",
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins", "safeBins"],
      }),
    );

    expect(command).toMatch(/^sh -c '\/.+\/tr a b && \/.+\/head -c 16'$/);
  });

  it("preserves non-rewritten wrapper payload commands", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'git status && head -c 16'",
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: [null, "safeBins"],
      }),
    );

    expect(command).toMatch(/^sh -c 'git status && \/.+\/head -c 16'$/);
  });

  it("source-preserves arguments for enforced POSIX commands", async () => {
    const plan = await planShellAuthorization({
      command: "head -c 16",
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "enforced",
        segmentSatisfiedBy: ["safeBins"],
      }),
    );

    expect(command).toMatch(/^\/.+\/head -c 16$/);
  });

  it("rewrites quoted POSIX executable source spans", async () => {
    const plan = await planShellAuthorization({
      command: '"head" -c 16',
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    );

    expect(command).toMatch(/^\/.+\/head -c 16$/);
  });

  it("fails closed for enforced POSIX commands with shell glob arguments", async () => {
    const plan = await planShellAuthorization({
      command: "ls *.ts",
      env: POSIX_ENV,
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).toEqual({ ok: false, reason: "shell expansion in enforced arguments" });
  });

  it("fails closed for enforced POSIX commands with tilde-expanded arguments", async () => {
    const plan = await planShellAuthorization({
      command: "cat ~/secret",
      env: POSIX_ENV,
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).toEqual({ ok: false, reason: "shell expansion in enforced arguments" });
  });

  it("preserves env assignment prefixes for enforced POSIX commands", async () => {
    const plan = await planShellAuthorization({
      command: "LIMIT=1 head -n 5",
      env: POSIX_ENV,
    });

    const command = renderOk(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    );

    expect(command).toMatch(/^LIMIT=1 \/.+\/head -n 5$/);
  });

  it("fails closed for enforced shell-wrapper payload rewrites", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'head -n 5'",
      env: POSIX_ENV,
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).toEqual({ ok: false, reason: "shell quoting required in wrapper payload" });
  });

  it("fails closed when shell-wrapper safe-bin rewrites would need outer quote escaping", async () => {
    const dir = path.join(makeTempDir(), "safe bin dir");
    fs.mkdirSync(dir);
    makeExecutable(dir, "head");
    const plan = await planShellAuthorization({
      command: "sh -c 'head -n 5'",
      env: makePathEnv(dir),
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    ).toEqual({ ok: false, reason: "shell quoting required in wrapper payload" });
  });

  it("fails closed when candidate metadata does not match the plan", async () => {
    const plan = await planShellAuthorization({
      command: "git diff | head",
      env: POSIX_ENV,
    });

    expect(
      buildAuthorizedShellCommandFromPlan({
        plan,
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    ).toEqual({ ok: false, reason: "segment metadata mismatch" });
  });
});
