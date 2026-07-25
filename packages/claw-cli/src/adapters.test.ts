import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { previewWithHarness, type AdapterRuntime } from "./adapters.js";
import { inspectLocalPackage } from "./source.js";

const validFixture = resolve("packages", "claw-cli", "test", "fixtures", "valid");
const bodyOnlyFixture = resolve("packages", "claw-cli", "test", "fixtures", "body-only");
const promptWithSoulFixture = resolve(
  "packages",
  "claw-cli",
  "test",
  "fixtures",
  "portable-minimal",
);

describe("standalone harness adapters", () => {
  it("delegates OpenClaw preview without reproducing lifecycle policy", async () => {
    const claw = await inspectLocalPackage(validFixture);
    let delegatedRoot: string | undefined;
    const run = vi.fn<AdapterRuntime["run"]>().mockImplementation(async (_command, args) => {
      delegatedRoot = args[3];
      expect(delegatedRoot).toBeDefined();
      await expect(readFile(resolve(delegatedRoot!, "CLAW.md"), "utf8")).resolves.toContain(
        "incident-triage",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ schemaVersion: "openclaw.clawAddPlan.v1", dryRun: true }),
        stderr: "",
      };
    });

    const result = await previewWithHarness("openclaw", claw, { run });

    expect(result).toEqual({
      id: "openclaw",
      outcome: { schemaVersion: "openclaw.clawAddPlan.v1", dryRun: true },
    });
    expect(run).toHaveBeenCalledOnce();
    const [, args, env, cwd] = run.mock.calls[0] ?? [];
    expect(args).toEqual([
      resolve("scripts", "run-node.mjs"),
      "claws",
      "add",
      delegatedRoot,
      "--dry-run",
      "--json",
    ]);
    expect(delegatedRoot).not.toBe(claw.source.path);
    await expect(access(delegatedRoot!)).rejects.toThrow();
    expect(env?.OPENCLAW_EXPERIMENTAL_CLAWS).toBe("1");
    expect(cwd).toBe(resolve("."));
  });

  it("fails closed for unknown harnesses", async () => {
    const claw = await inspectLocalPackage(validFixture);
    await expect(previewWithHarness("hermes", claw)).rejects.toMatchObject({
      diagnostics: [{ code: "unknown_adapter", phase: "adapter" }],
    });
  });

  it("preserves a rejected harness-native preview outcome", async () => {
    const claw = await inspectLocalPackage(validFixture);
    const outcome = {
      schemaVersion: "openclaw.clawAddPlan.v1",
      ok: false,
      blockers: [{ code: "capability_consent_required" }],
    };
    const run = vi.fn<AdapterRuntime["run"]>().mockResolvedValue({
      exitCode: 2,
      stdout: JSON.stringify(outcome),
      stderr: "",
    });

    await expect(previewWithHarness("openclaw", claw, { run })).rejects.toMatchObject({
      diagnostics: [{ code: "adapter_preview_failed", phase: "adapter" }],
      harness: { id: "openclaw", outcome },
    });
  });

  it("rejects body-only prompts until the OpenClaw adapter supports them", async () => {
    const claw = await inspectLocalPackage(bodyOnlyFixture);
    const run = vi.fn<AdapterRuntime["run"]>();

    await expect(previewWithHarness("openclaw", claw, { run })).rejects.toMatchObject({
      diagnostics: [{ code: "openclaw_portable_prompt_unsupported", phase: "adapter" }],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects portable prompts even when the package declares SOUL.md", async () => {
    const claw = await inspectLocalPackage(promptWithSoulFixture);
    const run = vi.fn<AdapterRuntime["run"]>();

    await expect(previewWithHarness("openclaw", claw, { run })).rejects.toMatchObject({
      diagnostics: [{ code: "openclaw_portable_prompt_unsupported", phase: "adapter" }],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies process launch failures as adapter failures", async () => {
    const claw = await inspectLocalPackage(validFixture);
    const run = vi
      .fn<AdapterRuntime["run"]>()
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(previewWithHarness("openclaw", claw, { run })).rejects.toMatchObject({
      diagnostics: [{ code: "adapter_launch_failed", phase: "adapter" }],
    });
  });
});
