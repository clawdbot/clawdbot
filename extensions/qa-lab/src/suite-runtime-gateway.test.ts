// Qa Lab tests cover suite runtime gateway plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyConfig,
  fetchJson,
  patchConfig,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

function createRestartSettleEnv(waitReady: (params: unknown) => Promise<void>) {
  return {
    gateway: { baseUrl: "http://127.0.0.1:43123" },
    transport: { waitReady },
  } as unknown as Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
}

function createConfigMutationEnv(
  gatewayCall: (method: string, params: unknown, options: unknown) => Promise<unknown>,
) {
  const waitReady = vi.fn(async (_params: { gateway: unknown; timeoutMs: number }) => {});
  const env = {
    gateway: {
      baseUrl: "http://127.0.0.1:43123",
      call: gatewayCall,
    },
    transport: {
      waitReady,
    },
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
  } as unknown as QaSuiteRuntimeEnv;
  return { env, waitReady };
}

describe("qa suite gateway helpers", () => {
  it("replaces the gateway process after writing the requested config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-gateway-restart-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, '{"gateway":{"auth":{"token":"keep-me"}}}\n', "utf8");
    const restartAfterStateMutation = vi.fn(
      async (
        mutateState: (context: {
          configPath: string;
          runtimeEnv: NodeJS.ProcessEnv;
          stateDir: string;
          tempRoot: string;
        }) => Promise<void>,
      ) => {
        await mutateState({
          configPath,
          runtimeEnv: {},
          stateDir: path.join(tempDir, "state"),
          tempRoot: tempDir,
        });
      },
    );
    try {
      await restartGatewayWithConfigPatch({
        env: { gateway: { restartAfterStateMutation } } as never,
        patch: { tools: { codeMode: { enabled: false } } },
      });

      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            gateway: { auth: { token: "keep-me" } },
            tools: { codeMode: { enabled: false } },
          },
          null,
          2,
        )}\n`,
      );
      expect(restartAfterStateMutation).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds oversized suite gateway JSON responses", async () => {
    let chunksRead = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRead === 0) {
            chunksRead += 1;
            controller.enqueue(new TextEncoder().encode('{"payload":"'));
            return;
          }
          if (chunksRead <= 256) {
            chunksRead += 1;
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
            return;
          }
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });

    await expect(fetchJson("http://127.0.0.1:43123/config")).rejects.toThrow(
      "qa-lab-suite-fetch-json: JSON response exceeds 16777216 bytes",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled suite gateway JSON response bodies", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async ({ timeoutMs }: { timeoutMs: number }) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            controller.enqueue(new TextEncoder().encode('{"pending":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      setTimeout(() => bodyController?.error(new Error("request timed out")), timeoutMs);
      return { response, release };
    });

    const request = fetchJson("http://127.0.0.1:43123/config", 1_000);
    const rejection = expect(request).rejects.toThrow("request timed out");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels failed suite gateway JSON response bodies before releasing their guard", async () => {
    const events: string[] = [];
    const cancelBody = vi.fn(() => {
      events.push("cancel");
      throw new Error("cancel failed");
    });
    const release = vi.fn(async () => {
      events.push("release");
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel: cancelBody,
        }),
        { status: 503 },
      ),
      release,
    });

    await expect(fetchJson("http://127.0.0.1:43123/config")).rejects.toThrow(
      "request failed 503: http://127.0.0.1:43123/config",
    );
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["cancel", "release"]);
  });

  it("cancels every ignored gateway health body before releasing its guard", async () => {
    const events: string[] = [];
    const failedCancel = vi.fn(() => {
      events.push("failed:cancel");
    });
    const successCancel = vi.fn(() => {
      events.push("success:cancel");
    });
    const failedRelease = vi.fn(async () => {
      events.push("failed:release");
    });
    const successRelease = vi.fn(async () => {
      events.push("success:release");
    });
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(
          new ReadableStream<Uint8Array>({
            cancel: failedCancel,
          }),
          { status: 503 },
        ),
        release: failedRelease,
      })
      .mockResolvedValueOnce({
        response: new Response(
          new ReadableStream<Uint8Array>({
            cancel: successCancel,
          }),
          { status: 200 },
        ),
        release: successRelease,
      });

    await expect(
      waitForGatewayHealthy({ gateway: { baseUrl: "http://127.0.0.1:43123" } } as never, 1_000),
    ).resolves.toBeUndefined();
    expect(failedCancel).toHaveBeenCalledTimes(1);
    expect(successCancel).toHaveBeenCalledTimes(1);
    expect(failedRelease).toHaveBeenCalledTimes(1);
    expect(successRelease).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "failed:cancel",
      "failed:release",
      "success:cancel",
      "success:release",
    ]);
  });

  it("bounds a hung gateway health request by the remaining readiness deadline", async () => {
    vi.useFakeTimers();
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ timeoutMs }: { timeoutMs: number }) =>
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), timeoutMs);
        }),
    );

    const readiness = waitForGatewayHealthy(
      { gateway: { baseUrl: "http://127.0.0.1:43123" } } as never,
      1_000,
    );
    const rejection = expect(readiness).rejects.toThrow("timed out after 1000ms");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("skips config mutations that would not change the snapshot", async () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        list: [{ id: "qa", model: { primary: "openai/gpt-5.6-luna" } }],
      },
      meta: {
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    };
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { env } = createConfigMutationEnv(gatewayCall);

    await expect(
      patchConfig({ env, patch: { tools: { deny: null } }, restartDelayMs: 0 }),
    ).resolves.toEqual({ ok: true, noop: true });
    await expect(
      applyConfig({
        env,
        nextConfig: { tools: config.tools, agents: config.agents },
        restartDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true, noop: true });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("ignores prototype keys in cleanup config patches", async () => {
    const config = { tools: { profile: "coding" } };
    const gatewayCall = vi.fn(async () => ({ hash: "hash-1", config }));
    const { env } = createConfigMutationEnv(gatewayCall);
    const patch = JSON.parse(
      '{"tools":{"profile":"coding"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
    ) as Record<string, unknown>;

    await expect(patchConfig({ env, patch, restartDelayMs: 0 })).resolves.toEqual({
      ok: true,
      noop: true,
    });
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("retries rate-limited config mutations using the primary gateway error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release: vi.fn(async () => {}),
    });
    let patchAttempts = 0;
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: `hash-${patchAttempts + 1}`, config: { tools: {} } };
      }
      patchAttempts += 1;
      if (patchAttempts === 1) {
        throw new Error(
          "rate limit exceeded for config.patch; retryAfterMs=1\nGateway logs:\nprevious config changed since last load",
        );
      }
      return { ok: true };
    });
    const { env } = createConfigMutationEnv(gatewayCall);

    await expect(
      patchConfig({
        env,
        patch: { tools: { deny: ["read"] } },
        restartDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true });
    expect(patchAttempts).toBe(2);
  });

  it("retries config hash conflicts from the primary gateway error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release: vi.fn(async () => {}),
    });
    let patchAttempts = 0;
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: `hash-${patchAttempts + 1}`, config: { tools: {} } };
      }
      patchAttempts += 1;
      if (patchAttempts === 1) {
        throw new Error(
          "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded; retry after 38s",
        );
      }
      return { ok: true };
    });
    const { env } = createConfigMutationEnv(gatewayCall);

    await expect(
      patchConfig({
        env,
        patch: { tools: { deny: ["read"] } },
        restartDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true });
    expect(patchAttempts).toBe(2);
  });

  it("uses the live timeout profile for config mutations and restart settle", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: { tools: {} } };
      }
      return { ok: true };
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);

    await patchConfig({
      env,
      patch: { tools: { deny: ["read"] } },
      restartDelayMs: 0,
    });

    expect(gatewayCall).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        raw: expect.stringContaining('"deny"'),
        baseHash: "hash-1",
      }),
      { timeoutMs: 180_000 },
    );
    expect(waitReady).toHaveBeenCalledWith({
      gateway: env.gateway,
      timeoutMs: expect.any(Number),
    });
    expect(waitReady.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(60_000);
  });

  it("does not wait for a deferred restart beyond the mutation timeout", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: { tools: {} } };
      }
      return { ok: true };
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);

    await patchConfig({
      env,
      patch: { tools: { deny: ["read"] } },
      restartDelayMs: 300_000,
    });

    expect(waitReady).toHaveBeenCalledWith({
      gateway: env.gateway,
      timeoutMs: 180_000,
    });
  });

  it("uses the live timeout profile when config mutation races a restart", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const snapshots = [
      { hash: "hash-1", config: { tools: {} } },
      { hash: "hash-2", config: { tools: { deny: ["read"] } } },
    ];
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return snapshots.shift() ?? snapshots.at(-1);
      }
      throw new Error("service restart");
    });
    const { env, waitReady } = createConfigMutationEnv(gatewayCall);

    const result = await patchConfig({
      env,
      patch: { tools: { deny: ["read"] } },
      restartDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, restarted: true });
    expect(waitReady).toHaveBeenCalledWith({
      gateway: env.gateway,
      timeoutMs: expect.any(Number),
    });
    expect(waitReady.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(60_000);
  });

  it("retries when a restart race settles before the config mutation is visible", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const snapshots = [
      { hash: "hash-1", config: { tools: {} } },
      { hash: "hash-2", config: { tools: {} } },
      { hash: "hash-2", config: { tools: {} } },
    ];
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return snapshots.shift() ?? { hash: "hash-3", config: { tools: { deny: ["read"] } } };
      }
      if (method === "config.patch" && gatewayCall.mock.calls.length < 4) {
        throw new Error("service restart");
      }
      return { ok: true };
    });
    const { env } = createConfigMutationEnv(gatewayCall);

    const mutation = patchConfig({
      env,
      patch: { tools: { deny: ["read"] } },
      replacePaths: ["tools.deny"],
      restartDelayMs: 0,
      restartSettleBufferMs: 1,
    });

    await expect(mutation).resolves.toEqual({ ok: true });

    expect(gatewayCall).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "hash-1",
        replacePaths: ["tools.deny"],
      }),
      { timeoutMs: 180_000 },
    );
    expect(gatewayCall).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "hash-2",
        replacePaths: ["tools.deny"],
      }),
      { timeoutMs: 180_000 },
    );
  });

  it("waits for transport readiness after gateway restart health", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const waitReady = vi.fn(async () => {});

    const settling = waitForConfigRestartSettle(createRestartSettleEnv(waitReady), 0, 5_000);

    await vi.advanceTimersByTimeAsync(750);
    await settling;

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:43123/readyz",
        auditContext: "qa-lab-suite-wait-for-gateway-healthy",
      }),
    );
    expect(waitReady).toHaveBeenCalledWith({
      gateway: { baseUrl: "http://127.0.0.1:43123" },
      timeoutMs: expect.any(Number),
    });
    expect(release).toHaveBeenCalled();
  });

  it("keeps polling gateway health instead of sleeping blindly through restart settle", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("restart boundary")).mockResolvedValue({
      response: { ok: true },
      release,
    });
    const waitReady = vi.fn(async () => {});

    const settling = waitForConfigRestartSettle(createRestartSettleEnv(waitReady), 500, 5_000);

    await vi.advanceTimersByTimeAsync(1_250);
    await settling;

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(waitReady).toHaveBeenCalledTimes(1);
  });
});
