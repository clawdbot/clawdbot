import { describe, expect, it } from "vitest";
import {
  evaluateLocalTestboxKey,
  evaluateOpenClawTestboxClaim,
  parseTestboxIdArg,
  resolveTestboxId,
  writeOpenClawTestboxClaim,
} from "../../scripts/blacksmith-testbox-state.mjs";

describe("blacksmith testbox state", () => {
  it("parses Testbox ids from args and env", () => {
    expect(parseTestboxIdArg(["--id", "tbx_abc123"])).toBe("tbx_abc123");
    expect(parseTestboxIdArg(["--testbox-id=tbx_def456"])).toBe("tbx_def456");
    expect(resolveTestboxId({ argv: [], env: { OPENCLAW_TESTBOX_ID: "tbx_env123" } })).toBe(
      "tbx_env123",
    );
  });

  it("fails when a remote-visible Testbox id has no local private key", () => {
    const result = evaluateLocalTestboxKey({
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      exists: () => false,
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
    });

    expect(result.ok).toBe(false);
    expect(result.keyPath).toBe("/state/testboxes/tbx_01kqap50t9fqggzw1akg5dtmmq/id_ed25519");
    expect(result.problems[0]).toContain("local Testbox SSH key missing");
  });

  it("accepts a Testbox id with a local private key", () => {
    const result = evaluateLocalTestboxKey({
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      exists: (file) => file.endsWith("/tbx_01kqap50t9fqggzw1akg5dtmmq/id_ed25519"),
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(true);
  });

  it("fails when a keyed Testbox id has no OpenClaw claim", () => {
    const result = evaluateOpenClawTestboxClaim({
      cwd: "/repo",
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      exists: () => false,
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
    });

    expect(result.ok).toBe(false);
    expect(result.claimPath).toBe(
      "/state/testboxes/tbx_01kqap50t9fqggzw1akg5dtmmq/openclaw-runner.json",
    );
    expect(result.problems[0]).toContain("OpenClaw Testbox claim missing");
  });

  it("fails when an OpenClaw claim belongs to a different checkout", () => {
    const result = evaluateOpenClawTestboxClaim({
      cwd: "/repo/current",
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      exists: () => true,
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      readFile: () => JSON.stringify({ repoRoot: "/repo/other" }),
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
    });

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("claim repo mismatch");
  });

  it("fails when an OpenClaw claim is stale after a crash or long pause", () => {
    const result = evaluateOpenClawTestboxClaim({
      cwd: "/repo/current",
      env: {
        OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes",
        OPENCLAW_TESTBOX_CLAIM_TTL_MINUTES: "90",
      },
      exists: () => true,
      now: () => new Date("2026-04-29T14:00:00.000Z"),
      readFile: () =>
        JSON.stringify({
          claimedAt: "2026-04-29T12:00:00.000Z",
          repoRoot: "/repo/current",
        }),
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
    });

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("claim is stale");
  });

  it("writes and accepts an OpenClaw Testbox claim for the current checkout", () => {
    const writes = new Map<string, string>();
    const claim = writeOpenClawTestboxClaim({
      cwd: "/repo/current",
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      mkdir: () => undefined,
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
      writeFile: (file, value) => writes.set(file, value),
    });

    expect(claim.payload).toEqual({
      claimedAt: "2026-04-29T12:00:00.000Z",
      repoRoot: "/repo/current",
      runnerVersion: 1,
    });
    expect(
      evaluateOpenClawTestboxClaim({
        cwd: "/repo/current",
        env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
        exists: (file) => writes.has(file),
        now: () => new Date("2026-04-29T12:30:00.000Z"),
        readFile: (file) => writes.get(file) ?? "",
        testboxId: "tbx_01kqap50t9fqggzw1akg5dtmmq",
      }).ok,
    ).toBe(true);
  });
});
