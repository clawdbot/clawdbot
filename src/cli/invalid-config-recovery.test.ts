import { describe, expect, it, vi } from "vitest";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { offerInvalidConfigRecovery } from "./invalid-config-recovery.js";

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

describe("offerInvalidConfigRecovery", () => {
  it("runs doctor and retries once after interactive consent", async () => {
    const runtime = createRuntime();
    const runDoctor = vi.fn(async () => {});
    const retry = vi.fn(async () => "started");

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry,
        deps: {
          confirm: vi.fn(async () => true),
          isInteractive: () => true,
          runDoctor,
        },
      }),
    ).resolves.toEqual({ status: "recovered", value: "started" });

    expect(runDoctor).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("prints the command without running doctor when consent is declined", async () => {
    const runtime = createRuntime();
    const runDoctor = vi.fn(async () => {});
    const retry = vi.fn(async () => {});

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry,
        deps: {
          confirm: vi.fn(async () => false),
          isInteractive: () => true,
          runDoctor,
        },
      }),
    ).resolves.toEqual({ status: "declined" });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(runDoctor).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("prints only the command in non-interactive mode", async () => {
    const runtime = createRuntime();
    const confirm = vi.fn(async () => true);
    const runDoctor = vi.fn(async () => {});
    const retry = vi.fn(async () => {});

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry,
        deps: { confirm, isInteractive: () => false, runDoctor },
      }),
    ).resolves.toEqual({ status: "declined" });

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(confirm).not.toHaveBeenCalled();
    expect(runDoctor).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("reports one failed retry without running doctor again", async () => {
    const runtime = createRuntime();
    const runDoctor = vi.fn(async () => {});
    const retry = vi.fn(async () => {
      throw createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: invalid");
    });

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry,
        deps: {
          confirm: vi.fn(async () => true),
          isInteractive: () => true,
          runDoctor,
        },
      }),
    ).resolves.toEqual({ status: "retry-failed" });

    expect(runDoctor).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Config is still invalid"));
  });

  it("reports doctor failures without retrying the command", async () => {
    const runtime = createRuntime();
    const retry = vi.fn(async () => "started");

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry,
        deps: {
          confirm: vi.fn(async () => true),
          isInteractive: () => true,
          runDoctor: vi.fn(async () => {
            throw new Error("repair unavailable");
          }),
        },
      }),
    ).resolves.toEqual({ status: "retry-failed" });

    expect(retry).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("repair unavailable"));
  });

  it("preserves intentional doctor exits", async () => {
    const runtime = createRuntime();

    await expect(
      offerInvalidConfigRecovery({
        runtime,
        retry: vi.fn(async () => "started"),
        deps: {
          confirm: vi.fn(async () => true),
          isInteractive: () => true,
          runDoctor: vi.fn(async () => {
            throw new ExitError(2);
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
