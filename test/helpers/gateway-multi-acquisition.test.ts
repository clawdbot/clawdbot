import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "./promise.js";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("./gateway-e2e-harness.js");
  vi.doUnmock("./openclaw-test-instance.js");
  vi.resetModules();
});

async function createAcquiredOwner() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("acquired owner did not bind");
  }
  let joined = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          joined = true;
          resolve();
        }
      });
    });
    return closing;
  };
  return { port: address.port, close, isJoined: () => joined };
}

describe("multi-Gateway suite acquisition ownership", () => {
  it.each([
    { boundary: "server", order: "before rejection" },
    { boundary: "server", order: "after rejection" },
    { boundary: "node", order: "before rejection" },
    { boundary: "node", order: "after rejection" },
  ] as const)(
    "retains the $boundary acquired $order through actual afterAll",
    async ({ boundary, order }) => {
      const owner = await createAcquiredOwner();
      const acquisitionError = new Error(`${boundary} acquisition failed`);
      const sibling = createDeferred();
      const failure = createDeferred<never>();
      const started = createDeferred();
      const resource =
        boundary === "server"
          ? { port: owner.port, hookToken: "synthetic-hook", cleanup: owner.close }
          : {
              nodeId: "synthetic-node",
              client: {
                stop: () => {
                  void owner.close();
                },
                stopAndWait: owner.close,
              },
            };
      const siblingAcquisition = sibling.promise.then(() => resource);
      // Observe both promises before injecting rejection, even if the suite drops them.
      const acquisitions = Promise.allSettled([siblingAcquisition, failure.promise]);
      const servers = [
        { port: owner.port, hookToken: "synthetic-a", cleanup: async () => {} },
        { port: owner.port, hookToken: "synthetic-b", cleanup: async () => {} },
      ];
      const bodies: Array<{ name: string; timeout: number; run: () => Promise<void> }> = [];
      const cleanups: Array<() => Promise<void>> = [];
      const capture = (name: string, options: { timeout: number }, run: () => Promise<void>) => {
        bodies.push({ name, timeout: options.timeout, run });
      };
      vi.doMock("vitest", () => ({
        afterAll: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
        describe: (_name: string, run: () => void) => run(),
        it: capture,
        expect,
      }));
      let acquisitionCount = 0;
      const acquire = () => {
        if (++acquisitionCount === 1) {
          return siblingAcquisition;
        }
        started.resolve();
        return failure.promise;
      };
      let serverIndex = 0;
      vi.doMock("./gateway-e2e-harness.js", () => ({
        spawnGatewayInstance: boundary === "server" ? acquire : async () => servers[serverIndex++],
        stopGatewayInstance: (instance: { cleanup: () => Promise<void> }) => instance.cleanup(),
        postJson: async () => ({ status: 200, json: { ok: true } }),
        connectNode: boundary === "node" ? acquire : vi.fn(),
        waitForNodeStatus: vi.fn(),
        connectGatewayStatusClient: vi.fn(),
      }));
      vi.doMock("./openclaw-test-instance.js", () => ({
        createOpenClawTestInstance: () => {
          throw new Error("unselected suite must not start a Gateway");
        },
      }));
      let bodyResult: Promise<unknown> | undefined;
      let cleanupResult: Promise<unknown> | undefined;
      try {
        // Capture the existing suite, including its real acquisition ordering and
        // teardown registry. No copy of the Promise.all under test lives here.
        await import("../gateway.multi.e2e.test.js");
        const acquisitionBody = bodies.find(
          (body) => body.name === "spins up two gateways and exercises WS + HTTP + node pairing",
        );
        expect(acquisitionBody?.timeout).toBe(120_000);
        expect(cleanups).toHaveLength(1);
        bodyResult = acquisitionBody!.run().then(
          () => undefined,
          (error: unknown) => error,
        );
        await started.promise;
        if (order === "before rejection") {
          sibling.resolve();
          await siblingAcquisition;
        }
        failure.reject(acquisitionError);
        await setImmediate();
        let cleanupSettled = false;
        let ownerJoinedAtCleanupSettlement = false;
        cleanupResult = cleanups[0]!()
          .then(
            () => undefined,
            (error: unknown) => error,
          )
          .then((error) => {
            ownerJoinedAtCleanupSettlement = owner.isJoined();
            cleanupSettled = true;
            return error;
          });
        await setImmediate();
        const cleanupSettledBeforeLateAcquisition = cleanupSettled;
        sibling.resolve();
        await acquisitions;
        const bodyError = await bodyResult;
        const cleanupError = await cleanupResult;
        expect(bodyError).toBe(acquisitionError);
        expect(cleanupError).toBeUndefined();
        if (order === "after rejection") {
          expect(cleanupSettledBeforeLateAcquisition).toBe(false);
        }
        expect(ownerJoinedAtCleanupSettlement).toBe(true);
      } finally {
        // Settle late acquisitions and close their independently retained native
        // handles even when the actual suite lost its only cleanup reference.
        sibling.resolve();
        failure.reject(acquisitionError);
        await acquisitions;
        await bodyResult;
        await cleanupResult;
        await owner.close();
      }
    },
  );
});
