import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, onTestFinished, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Observe the exact work owner; connection scopes also join server-side transport release. */
export async function observeHeldGatewayWorkDrain(getSignal?: () => AbortSignal | undefined) {
  const connections = new Set<symbol>();
  const entered = createDeferredCore();
  let connectionSignal: AbortSignal | undefined;
  let draining = false;
  let drained = false;
  const ready = () => {
    if (draining && connections.size === 0) {
      entered.resolve();
    }
  };
  // oxlint-disable-next-line typescript/unbound-method -- Capture the native method before spying; every invocation binds its actual scope with .call(this).
  const drain = AsyncWorkScope.prototype.drain;
  const observation = vi.spyOn(AsyncWorkScope.prototype, "drain");
  observation.mockImplementation(async function (this: AsyncWorkScope) {
    if (this.signal !== (getSignal ? getSignal() : connectionSignal)) {
      return await drain.call(this);
    }
    draining = true;
    ready();
    await drain.call(this);
    drained = true;
  });
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
              ready();
            };
          });
        onTestFinished(() => registration.mockRestore());
        return kernel;
      });
    onTestFinished(() => factory.mockRestore());
  }

  return async (closing: Promise<unknown>) => {
    await Promise.race([entered.promise, closing]);
    await nextTurn();
    expect(draining, "Gateway close must enter the held work owner").toBe(true);
    expect(drained, "Gateway work drain must remain pending while work is held").toBe(false);
  };
}
