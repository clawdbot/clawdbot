import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

const machineNameDelay = vi.hoisted(() => {
  let enteredResolve = () => {};
  let releaseResolve = () => {};
  let entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    waitUntilDelayed: async () => {
      await entered;
    },
    release: () => {
      releaseResolve();
    },
    reset: () => {
      entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    run: async () => {
      enteredResolve();
      await release;
      return "test-machine";
    },
  };
});

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: () => machineNameDelay.run(),
}));

installGatewayTestHooks({ scope: "suite" });

afterEach(() => {
  machineNameDelay.release();
});

describe("gateway startup websocket readiness", () => {
  it("does not bind the websocket port until websocket handlers are attached", async () => {
    machineNameDelay.reset();
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    try {
      const port = await getFreePort();
      const startup = startGatewayServer(port, {
        auth: { mode: "none" },
      });
      await machineNameDelay.waitUntilDelayed();

      const pendingUpgrade = await new Promise<
        { kind: "error"; code?: string } | { kind: "response"; status: number; body: string }
      >((resolve) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          path: "/",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
            "Sec-WebSocket-Version": "13",
          },
        });
        req.once("error", (err) => {
          resolve({ kind: "error", code: (err as NodeJS.ErrnoException).code });
        });
        req.once("response", (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.once("end", () => {
            resolve({ kind: "response", status: res.statusCode ?? 0, body });
          });
        });
        req.end();
      });

      expect(pendingUpgrade).toEqual({ kind: "error", code: "ECONNREFUSED" });

      machineNameDelay.release();
      server = await startup;
      expect(server).toBeDefined();
    } finally {
      machineNameDelay.release();
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });

  it("accepts an immediate websocket connection once startup resolves", async () => {
    machineNameDelay.reset();
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      const port = await getFreePort();
      machineNameDelay.release();
      server = await startGatewayServer(port, {
        auth: { mode: "none" },
      });

      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        timeoutMs: 5_000,
        timeoutMessage: "expected websocket connect to succeed immediately after startup",
      });

      expect(client).toBeDefined();
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });
});
