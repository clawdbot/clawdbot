import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { runCrestodianWithInference } from "./crestodian-with-inference.js";

const exitMocks = vi.hoisted(() => ({
  requestExitAfterOneShotOutput: vi.fn(),
}));

vi.mock("../cli/one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: exitMocks.requestExitAfterOneShotOutput,
}));

function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

const tty = { isTTY: true } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const pipe = { isTTY: false } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const verifiedInference = { execution: { modelLabel: "openai/gpt-5.5" } } as never;

function workingInference() {
  return {
    ok: true as const,
    modelRef: "openai/gpt-5.5",
    latencyMs: 100,
    binding: verifiedInference,
  };
}

describe("runCrestodianWithInference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exitMocks.requestExitAfterOneShotOutput.mockReturnValue(false);
  });

  it("starts Crestodian only after live inference succeeds", async () => {
    const runCrestodian = vi.fn(async () => {});
    const verifyInference = vi.fn(async () => workingInference());
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { input: tty, output: tty },
      currentRuntime,
      {},
      {
        verifyInference,
        runCrestodian,
      },
    );

    expect(verifyInference).toHaveBeenCalledWith({
      runtime: currentRuntime,
      bindSession: true,
    });
    expect(runCrestodian).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedInference }),
      currentRuntime,
    );
    expect(verifyInference.mock.invocationCallOrder[0]).toBeLessThan(
      runCrestodian.mock.invocationCallOrder[0]!,
    );
    expect(exitMocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it.each([
    { label: "message", options: { message: "status" } },
    { label: "JSON", options: { json: true } },
    { label: "noninteractive", options: { interactive: false } },
  ])("requests a clean process exit after successful $label output", async ({ options }) => {
    const runCrestodian = vi.fn(async () => {});
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      options,
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => workingInference()),
        runCrestodian,
      },
    );

    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime);
    expect(runCrestodian.mock.invocationCallOrder[0]).toBeLessThan(
      exitMocks.requestExitAfterOneShotOutput.mock.invocationCallOrder[0]!,
    );
  });

  it("reports a one-shot execution error once and requests exit code 1", async () => {
    const currentRuntime = runtime();
    const runCrestodian = vi.fn(async () => {
      throw new Error("Plugin install spec is invalid.");
    });

    await runCrestodianWithInference(
      { message: "install plugin https://example.test/plugin.tgz", yes: true },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => workingInference()),
        runCrestodian,
      },
    );

    expect(currentRuntime.error).toHaveBeenCalledOnce();
    expect(currentRuntime.error).toHaveBeenCalledWith("Plugin install spec is invalid.");
    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledOnce();
    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("defers a one-shot execution-error exit when the default runtime owns draining", async () => {
    exitMocks.requestExitAfterOneShotOutput.mockReturnValueOnce(true);
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { message: "broken request" },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => workingInference()),
        runCrestodian: vi.fn(async () => {
          throw new Error("operation failed");
        }),
      },
    );

    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).not.toHaveBeenCalled();
  });

  it("returns one drained JSON error when inference verification throws", async () => {
    exitMocks.requestExitAfterOneShotOutput.mockReturnValueOnce(true);
    const currentRuntime = runtime();
    const runCrestodian = vi.fn(async () => {});

    await runCrestodianWithInference(
      { json: true },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => {
          throw new Error("verification exploded");
        }),
        runCrestodian,
      },
    );

    expect(currentRuntime.log).toHaveBeenCalledOnce();
    expect(currentRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('"error": "verification exploded"'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(runCrestodian).not.toHaveBeenCalled();
    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledOnce();
    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).not.toHaveBeenCalled();
  });

  it("lets interactive Crestodian execution errors propagate", async () => {
    const currentRuntime = runtime();

    await expect(
      runCrestodianWithInference(
        { input: tty, output: tty },
        currentRuntime,
        {},
        {
          verifyInference: vi.fn(async () => workingInference()),
          runCrestodian: vi.fn(async () => {
            throw new Error("interactive operation failed");
          }),
        },
      ),
    ).rejects.toThrow("interactive operation failed");

    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(exitMocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("routes an interactive inference failure into guided setup", async () => {
    const runGuidedOnboarding = vi.fn(async () => {});
    const runCrestodian = vi.fn(async () => {});
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { input: tty, output: tty },
      currentRuntime,
      { workspace: "/tmp/work", acceptRisk: true },
      {
        verifyInference: vi.fn(async () => ({
          ok: false as const,
          status: "auth" as const,
          error: "login expired",
        })),
        runGuidedOnboarding,
        runCrestodian,
      },
    );

    expect(runGuidedOnboarding).toHaveBeenCalledWith(
      { workspace: "/tmp/work", acceptRisk: true },
      currentRuntime,
    );
    expect(runCrestodian).not.toHaveBeenCalled();
  });

  it("rejects an impossible interactive request before probing inference", async () => {
    const currentRuntime = runtime();
    const verifyInference = vi.fn();

    await runCrestodianWithInference(
      { input: pipe, output: pipe },
      currentRuntime,
      {},
      { verifyInference },
    );

    expect(currentRuntime.error).toHaveBeenCalledWith(
      "Crestodian needs an interactive TTY. Use --message for one command.",
    );
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
    expect(verifyInference).not.toHaveBeenCalled();
  });

  it("rejects session-wide --yes before probing inference", async () => {
    const currentRuntime = runtime();
    const verifyInference = vi.fn();

    await runCrestodianWithInference(
      { input: tty, output: tty, yes: true },
      currentRuntime,
      {},
      { verifyInference },
    );

    expect(currentRuntime.error).toHaveBeenCalledWith(
      "Crestodian --yes requires --message so approval is limited to one request.",
    );
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
    expect(verifyInference).not.toHaveBeenCalled();
  });

  it("returns one structured error for --json --yes without a message", async () => {
    const currentRuntime = runtime();

    await runCrestodianWithInference({ json: true, yes: true }, currentRuntime);

    expect(currentRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('"error": "Crestodian --yes requires --message'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { label: "one-shot", options: { message: "status" } },
    { label: "noninteractive", options: { interactive: false } },
  ])(
    "fails $label mode with onboarding guidance when inference is unavailable",
    async ({ options }) => {
      const currentRuntime = runtime();
      const runGuidedOnboarding = vi.fn(async () => {});

      await runCrestodianWithInference(
        options,
        currentRuntime,
        {},
        {
          verifyInference: vi.fn(async () => ({
            ok: false as const,
            status: "unavailable" as const,
            error: "no configured model",
          })),
          runGuidedOnboarding,
        },
      );

      expect(currentRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw onboard"),
      );
      expect(currentRuntime.exit).toHaveBeenCalledWith(1);
      expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
      expect(runGuidedOnboarding).not.toHaveBeenCalled();
    },
  );

  it("returns a structured JSON error when inference is unavailable", async () => {
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { json: true },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => ({
          ok: false as const,
          status: "auth" as const,
          error: "login expired",
        })),
      },
    );

    expect(currentRuntime.log).toHaveBeenCalledWith(expect.stringContaining('"status": "auth"'));
    expect(currentRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('"guidance": "Run `openclaw onboard`'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("defers a failed one-shot exit until output streams drain", async () => {
    exitMocks.requestExitAfterOneShotOutput.mockReturnValueOnce(true);
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { json: true },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => ({
          ok: false as const,
          status: "auth" as const,
          error: "login expired",
        })),
      },
    );

    expect(exitMocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).not.toHaveBeenCalled();
  });
});
