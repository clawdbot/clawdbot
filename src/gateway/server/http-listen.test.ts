import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { listenGatewayHttpServer } from "./http-listen.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

vi.mock("../../utils.js", () => ({
  sleep: (ms: number) => sleepMock(ms),
}));

type ListenOutcome = { kind: "error"; code: string } | { kind: "listening" };

function createFakeHttpServer(outcomes: ListenOutcome[]) {
  class FakeHttpServer extends EventEmitter {
    public closeCalls = 0;
    private attempt = 0;

    listen(_port: number, _host: string) {
      const outcome = outcomes[this.attempt] ?? { kind: "listening" };
      this.attempt += 1;
      setImmediate(() => {
        if (outcome.kind === "error") {
          const err = Object.assign(new Error(outcome.code), { code: outcome.code });
          this.emit("error", err);
        } else {
          this.emit("listening");
        }
      });
      return this;
    }

    close(cb?: () => void) {
      this.closeCalls += 1;
      setImmediate(() => cb?.());
      return this;
    }
  }

  return new FakeHttpServer();
}

describe("listenGatewayHttpServer", () => {
  it("retries EADDRINUSE and closes server handle before retry", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer([
      { kind: "error", code: "EADDRINUSE" },
      { kind: "listening" },
    ]);

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).resolves.toBeUndefined();

    expect(fake.closeCalls).toBe(1);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it("throws GatewayLockError after EADDRINUSE retries are exhausted", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer(
      Array.from({ length: 22 }, () => ({ kind: "error" as const, code: "EADDRINUSE" })),
    );

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(fake.closeCalls).toBe(20);
  });

  it("wraps non-EADDRINUSE errors as GatewayLockError", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer([{ kind: "error", code: "EACCES" }]);

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(fake.closeCalls).toBe(0);
  });
});
