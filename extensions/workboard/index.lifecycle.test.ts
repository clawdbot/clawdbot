import { Command } from "commander";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginService } from "./api.js";
import plugin from "./index.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { WorkboardStore } from "./src/store.js";

function registerGeneration(register: (api: OpenClawPluginApi) => void = plugin.register) {
  const services: OpenClawPluginService[] = [];
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  let gatewayStart = () => {};
  let gatewayStop = () => {};
  const captured = capturePluginRegistration({
    ...plugin,
    register(api) {
      api.registerService = (service) => {
        services.push(service);
      };
      api.registerGatewayMethod = (method, handler) => {
        methods.set(method, handler);
      };
      api.on = (name, handler) => {
        if (name === "gateway_start") {
          gatewayStart = () => {
            void (handler as Parameters<typeof api.on<"gateway_start">>[1])({ port: 0 }, {});
          };
        } else if (name === "gateway_stop") {
          gatewayStop = () => {
            void (handler as Parameters<typeof api.on<"gateway_stop">>[1])({}, {});
          };
        }
      };
      register(api);
    },
  });
  const warn = vi.fn();
  const emit = vi.fn();
  const serviceContext = {
    config: {},
    stateDir: process.env.OPENCLAW_STATE_DIR!,
    logger: { ...captured.api.logger, warn },
    gatewayEvents: { emit, onSessionsChanged: () => () => {} },
  };
  const start = async () => {
    for (const service of services) {
      await service.start(serviceContext);
    }
    gatewayStart();
    await vi.advanceTimersByTimeAsync(0);
  };
  const stop = async () => {
    gatewayStop();
    for (const service of services) {
      await service.stop?.(serviceContext);
    }
  };
  const cleanup = async (
    context: Parameters<NonNullable<(typeof captured.runtimeLifecycles)[number]["cleanup"]>>[0],
  ) => {
    for (const lifecycle of captured.runtimeLifecycles) {
      await lifecycle.cleanup?.(context);
    }
  };
  const run = async (...args: string[]): Promise<unknown> => {
    const program = new Command().exitOverride();
    for (const registration of captured.cliRegistrars) {
      await registration.register({
        program,
        parentPath: [],
        config: {},
        logger: captured.api.logger,
      });
    }
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await program.parseAsync(["workboard", ...args, "--json"], { from: "user" });
      return JSON.parse(chunks.join(""));
    } finally {
      write.mockRestore();
    }
  };
  const call = async (method: string, params = {}) => {
    const handler = methods.get(method);
    if (!handler) {
      throw new Error(`Missing Gateway method: ${method}`);
    }
    const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
    await handler({ params, respond } as unknown as Parameters<typeof handler>[0]);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    return { ok, payload, error };
  };
  return { cleanup, run, start, stop, warn, emit, call };
}

describe("Workboard registration cleanup", () => {
  it.each(["disable", "restart"] as const)(
    "closes only the retired generation on %s",
    async (reason) => {
      await withStateDirEnv("workboard-registration-lifecycle-", async () => {
        vi.useFakeTimers();
        const first = registerGeneration();
        const second = registerGeneration();
        try {
          await first.start();
          await first.run("create", "Retained card");
          for (const context of [
            { reason: "reset" as const },
            { reason: "delete" as const },
            { reason, sessionKey: "agent:other:session" },
            { reason, runId: "other-run" },
          ]) {
            await first.cleanup(context);
            await expect(first.run("list")).resolves.toMatchObject({
              cards: [expect.objectContaining({ title: "Retained card" })],
            });
          }

          expect(vi.getTimerCount()).toBeGreaterThan(0);
          await first.cleanup({ reason });
          await expect(first.run("list")).rejects.toThrow("workboard store is closed.");
          await vi.advanceTimersByTimeAsync(60_000);
          expect(first.warn).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
          await second.start();
          await expect(second.run("create", "Fresh card")).resolves.toMatchObject({
            card: { title: "Fresh card" },
          });
          await expect(second.run("list")).resolves.toMatchObject({
            cards: expect.arrayContaining([
              expect.objectContaining({ title: "Retained card" }),
              expect.objectContaining({ title: "Fresh card" }),
            ]),
          });
          await first.cleanup({ reason });
          second.emit.mockClear();
          await second.run("create", "After repeated retirement");
          expect(second.emit).toHaveBeenCalled();
        } finally {
          await first.stop();
          await second.stop();
          await first.cleanup({ reason: "disable" });
          await second.cleanup({ reason: "disable" });
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["internal", "injected"] as const)(
    "retains public Gateway store ownership for %s stores",
    async (ownership) => {
      await withStateDirEnv("workboard-gateway-lifecycle-", async () => {
        const store = ownership === "injected" ? WorkboardStore.openSqlite() : undefined;
        const generation = registerGeneration((api) =>
          registerWorkboardGatewayMethods({ api, store }),
        );
        try {
          expect(await generation.call("workboard.cards.list")).toMatchObject({
            ok: true,
            payload: { cards: [] },
          });
          expect(
            await generation.call("workboard.boards.upsert", {
              id: "retained",
              name: "Retained board",
            }),
          ).toMatchObject({ ok: true });
          await generation.cleanup({ reason: "disable", sessionKey: "agent:other:session" });
          expect(await generation.call("workboard.cards.list")).toMatchObject({ ok: true });
          await generation.cleanup({ reason: "disable" });
          expect(await generation.call("workboard.cards.list")).toMatchObject({
            ok: ownership === "injected",
          });
          const reopened = WorkboardStore.openSqlite();
          try {
            expect(await reopened.listBoards()).toMatchObject({
              boards: expect.arrayContaining([
                expect.objectContaining({ id: "retained", name: "Retained board" }),
              ]),
            });
          } finally {
            await reopened.close();
          }
        } finally {
          await generation.cleanup({ reason: "disable" });
          await store?.close();
        }
      });
    },
  );
});
