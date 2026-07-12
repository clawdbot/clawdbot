// Qa Lab tests cover suite runtime gateway plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJson,
  getGatewayRetryAfterMs,
  isConfigApplyNoopForSnapshot,
  isConfigHashConflict,
  isConfigPatchNoopForSnapshot,
  patchConfig,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
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
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads retry-after from the primary gateway error before appended logs", () => {
    const error = new Error(
      "rate limit exceeded for config.patch; retry after 38s\nGateway logs:\nprevious config changed since last load",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(38_000);
    expect(isConfigHashConflict(error)).toBe(false);
  });

  it("ignores stale retry-after text that only appears in appended gateway logs", () => {
    const error = new Error(
      "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded for config.patch; retry after 38s",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(null);
    expect(isConfigHashConflict(error)).toBe(true);
  });

  it("detects cleanup config patches that would not change the snapshot", () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        list: [{ id: "qa", model: { primary: "openai/gpt-5.6-luna" } }],
      },
    };

    expect(
      isConfigPatchNoopForSnapshot(
        config,
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed merge patches eligible for the gateway", () => {
    expect(
      isConfigPatchNoopForSnapshot(
        {
          tools: {
            deny: ["image_generate"],
          },
        },
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("ignores prototype keys when detecting no-op config patches", () => {
    expect(
      isConfigPatchNoopForSnapshot(
        {
          tools: {
            profile: "coding",
          },
        },
        '{"tools":{"profile":"coding"},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
      ),
    ).toBe(true);
  });

  it("detects full config applies that only differ by gateway-written metadata", () => {
    const config = {
      gateway: {
        controlUi: {
          allowedOrigins: ["http://127.0.0.1:5173"],
        },
      },
      meta: {
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    };

    expect(
      isConfigApplyNoopForSnapshot(
        config,
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed full config applies eligible for the gateway", () => {
    expect(
      isConfigApplyNoopForSnapshot(
        {
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
          meta: {
            updatedAt: "2026-04-25T10:00:00.000Z",
          },
        },
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5174"],
            },
          },
        }),
      ),
    ).toBe(false);
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
