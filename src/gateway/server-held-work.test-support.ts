import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, onTestFinished, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";

/** Observe the exact work owner; connection scopes also join server-side transport release. */
export async function observeHeldGatewayWorkDrain(getSignal?: () => AbortSignal | undefined) {
  const connections = new Set<symbol>();
  let connectionSignal: AbortSignal | undefined;
  const observation = vi.spyOn(AsyncWorkScope.prototype, "drain");
  onTestFinished(() => observation.mockRestore());

  if (!getSignal) {
    const kernelModule = await import("./server-kernel.js");
    const createKernel = kernelModule.createGatewayKernel;
    const factory = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementationOnce(async (...args) => {
        const kernel = await createKernel(...args);
        connectionSignal = kernel.connectionWork.signal;
        const register = kernel.connectionWork.registerConnection.bind(kernel.connectionWork);
        const registration = vi
          .spyOn(kernel.connectionWork, "registerConnection")
          .mockImplementation((close) => {
            const key = Symbol("gateway connection");
            connections.add(key);
            const release = register(close);
            return () => {
              release();
              connections.delete(key);
            };
          });
        onTestFinished(() => registration.mockRestore());
        return kernel;
      });
    onTestFinished(() => factory.mockRestore());
  }

  return async (closing: Promise<unknown>) => {
    let closed = false;
    const onClosed = () => {
      closed = true;
    };
    void closing.then(onClosed, onClosed);
    let drainIndex = -1;
    await vi.waitFor(
      () => {
        const signal = getSignal ? getSignal() : connectionSignal;
        drainIndex = observation.mock.contexts.findIndex(
          (scope) => scope instanceof AsyncWorkScope && scope.signal === signal,
        );
        expect(closed || (drainIndex >= 0 && connections.size === 0)).toBe(true);
      },
      { interval: 1, timeout: 10_000 },
    );
    await Promise.race([closing, nextTurn()]);
    expect(drainIndex, "Gateway close must enter the held work owner").toBeGreaterThanOrEqual(0);
    expect(connections.size, "Gateway connections must release before held work").toBe(0);
    expect(closed, "Gateway close must remain pending while work is held").toBe(false);
    expect(
      observation.mock.settledResults[drainIndex]?.type,
      "Gateway work drain must remain pending while work is held",
    ).toBe("incomplete");
  };
}
