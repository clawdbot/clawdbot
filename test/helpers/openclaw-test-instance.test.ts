// OpenClaw test instance tests cover spawned test instance lifecycle.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestInstance, testing } from "./openclaw-test-instance.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${targetPath}`);
}

function createGatewayProcessState(
  overrides: Partial<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> = {},
) {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    ...overrides,
  });
}

describe("openclaw test instance", () => {
  it("keeps only bounded child output tails in helper logs", () => {
    const stdout = testing.createBoundedStringLog();
    const stderr = testing.createBoundedStringLog();

    testing.appendLogChunk(stdout, `old stdout ${"x".repeat(64)}\n`, 32);
    testing.appendLogChunk(stdout, "recent stdout\n", 32);
    testing.appendLogChunk(stderr, `old stderr ${"y".repeat(64)}\n`, 32);
    testing.appendLogChunk(stderr, "recent stderr\n", 32);

    const logs = testing.formatLogs(stdout, stderr);
    expect(logs).toContain("[output truncated to last");
    expect(logs).toContain("recent stdout");
    expect(logs).toContain("recent stderr");
    expect(logs).not.toContain("old stdout");
    expect(logs).not.toContain("old stderr");
  });

  it("treats signaled gateway children as exited", () => {
    expect(testing.hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(testing.hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(testing.hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("fails startup waits immediately after signaled gateway exits", async () => {
    await expect(
      testing.waitForGatewayReady(
        createGatewayProcessState({ signalCode: "SIGTERM" }),
        [],
        [],
        1,
        10_000,
      ),
    ).rejects.toThrow("gateway exited before readiness");
  });

  it("waits until the gateway readiness probe reports ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"ready":false,"failing":["startup-sidecars"]}', { status: 503 }),
      )
      .mockResolvedValueOnce(new Response('{"ready":true,"failing":[]}', { status: 200 }));

    await expect(
      testing.waitForGatewayReady(createGatewayProcessState(), [], [], 12345, 1_000, fetchImpl),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12345/readyz");
  });

  it("keeps stalled readiness probes inside the startup deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const startedAt = Date.now();

    await expect(
      testing.waitForGatewayReady(createGatewayProcessState(), [], [], 12345, 25, fetchImpl),
    ).rejects.toThrow("timeout waiting for gateway readiness");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("aborts a stalled readiness probe when the gateway exits", async () => {
    const processState = createGatewayProcessState();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const startedAt = Date.now();
    setTimeout(() => {
      processState.signalCode = "SIGTERM";
      processState.emit("exit", null, "SIGTERM");
    }, 25);

    await expect(
      testing.waitForGatewayReady(processState, [], [], 12345, 5_000, fetchImpl),
    ).rejects.toThrow("gateway exited before readiness");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("signals test instance process groups on POSIX", () => {
    const child = {
      pid: 1234,
      kill: vi.fn(() => true),
    };
    const killProcess = vi.fn(() => true);

    testing.signalOpenClawTestProcess(child, "SIGKILL", killProcess);

    if (process.platform === "win32") {
      expect(killProcess).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } else {
      expect(killProcess).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("creates isolated config and spawn env without mutating process env", async () => {
    const previousHome = process.env.HOME;
    const inst = await createOpenClawTestInstance({
      name: "instance-unit",
      gatewayToken: "gateway-token",
      hookToken: "hook-token",
      config: {
        gateway: {
          bind: "loopback",
        },
      },
      env: {
        OPENCLAW_SKIP_CRON: "0",
      },
    });

    try {
      expect(process.env.HOME).toBe(previousHome);
      expect(inst.homeDir).toBe(path.join(inst.state.root, "home"));
      expect(inst.stateDir).toBe(path.join(inst.homeDir, ".openclaw"));
      expect(inst.configPath).toBe(path.join(inst.stateDir, "openclaw.json"));
      expect(inst.env.HOME).toBe(inst.homeDir);
      expect(inst.env.OPENCLAW_STATE_DIR).toBe(inst.stateDir);
      expect(inst.env.OPENCLAW_CONFIG_PATH).toBe(inst.configPath);
      expect(inst.env.OPENCLAW_SKIP_CRON).toBe("0");

      const config = JSON.parse(await fs.readFile(inst.configPath, "utf8"));
      expect(config).toStrictEqual({
        gateway: {
          bind: "loopback",
          port: inst.port,
          auth: {
            mode: "token",
            token: "gateway-token",
          },
          controlUi: {
            enabled: false,
          },
        },
        hooks: {
          enabled: true,
          token: "hook-token",
          path: "/hooks",
        },
      });
    } finally {
      await inst.cleanup();
    }

    await expectPathMissing(inst.state.root);
  });
});
