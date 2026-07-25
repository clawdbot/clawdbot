import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CliError } from "./errors.js";
import { inspectLocalPackage } from "./source.js";

const validFixture = resolve("packages", "claw-cli", "test", "fixtures", "valid");

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (value: string | Uint8Array) => {
          stdout += value.toString();
          return true;
        },
      },
      stderr: {
        write: (value: string | Uint8Array) => {
          stderr += value.toString();
          return true;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("standalone Claw CLI", () => {
  it("is unavailable without the existing experimental Claws gate", async () => {
    const capture = output();
    const exitCode = await runCli(["inspect", validFixture, "--json"], {
      io: capture.io,
      env: {},
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.read().stderr)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "experimental_claws_disabled" }],
    });
  });

  it("returns content-free inspection JSON", async () => {
    const capture = output();
    const exitCode = await runCli(["inspect", validFixture, "--json"], {
      io: capture.io,
      env: { OPENCLAW_EXPERIMENTAL_CLAWS: "1" },
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(capture.read().stdout);
    expect(result).toMatchObject({
      schemaVersion: "claw.cliOutcome.v0",
      stability: "private-incubation",
      operation: "inspect",
      ok: true,
      claw: { agent: { id: "incident-triage" } },
    });
    expect(capture.read().stdout).not.toContain("Review incoming incidents");
  });

  it("dispatches dry-run preview through the selected adapter", async () => {
    const capture = output();
    const preview = vi.fn().mockResolvedValue({ id: "openclaw", outcome: { dryRun: true } });
    const exitCode = await runCli([validFixture, "--agent", "openclaw", "--dry-run", "--json"], {
      io: capture.io,
      env: { OPENCLAW_EXPERIMENTAL_CLAWS: "1" },
      dependencies: { inspect: inspectLocalPackage, preview },
    });

    expect(exitCode).toBe(0);
    expect(preview).toHaveBeenCalledWith(
      "openclaw",
      expect.objectContaining({ source: expect.objectContaining({ kind: "local-package" }) }),
    );
    expect(JSON.parse(capture.read().stdout)).toMatchObject({
      operation: "preview",
      harness: { id: "openclaw", outcome: { dryRun: true } },
    });
  });

  it("returns a rejected harness-native outcome with adapter diagnostics", async () => {
    const capture = output();
    const harness = { id: "openclaw", outcome: { ok: false, blockers: ["consent"] } };
    const preview = vi
      .fn()
      .mockRejectedValue(
        new CliError(
          { code: "adapter_preview_failed", phase: "adapter", message: "Rejected." },
          { harness },
        ),
      );
    const exitCode = await runCli([validFixture, "--agent", "openclaw", "--dry-run", "--json"], {
      io: capture.io,
      env: { OPENCLAW_EXPERIMENTAL_CLAWS: "1" },
      dependencies: { inspect: inspectLocalPackage, preview },
    });

    expect(exitCode).toBe(3);
    expect(JSON.parse(capture.read().stderr)).toMatchObject({
      ok: false,
      harness,
      diagnostics: [{ code: "adapter_preview_failed" }],
    });
  });
});
