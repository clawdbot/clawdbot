/**
 * Lazy ACP runtime proxy for ACPX. It defers resolving the real runtime until
 * the first ACP call while preserving the SDK runtime shape.
 */
import type { AcpRuntime, AcpRuntimeTurn, AcpRuntimeTurnInput } from "../runtime-api.js";

export type CompleteAcpRuntimeTurn = AcpRuntimeTurn &
  Required<Pick<AcpRuntimeTurn, "promptStarted">>;

/**
 * Contract for runtimes this extension resolves behind the lazy proxy. The
 * SDK keeps these hooks optional for third-party backends, but every ACPX
 * runtime (the extension's AcpxRuntime and the upstream acpx runtime)
 * implements the full surface. Requiring them here turns an absent hook into
 * a compile error instead of a silently fabricated success at runtime.
 */
export type CompleteAcpRuntime = Omit<AcpRuntime, "startTurn"> &
  Required<
    Pick<
      AcpRuntime,
      | "getCapabilities"
      | "getStatus"
      | "setMode"
      | "setConfigOption"
      | "doctor"
      | "prepareFreshSession"
    >
  > & {
    startTurn(input: AcpRuntimeTurnInput): CompleteAcpRuntimeTurn;
  };

/** Start an ACP turn through a lazy runtime resolver without awaiting resolution up front. */
function lazyStartRuntimeTurn(
  resolveRuntime: () => Promise<CompleteAcpRuntime>,
  input: AcpRuntimeTurnInput,
): CompleteAcpRuntimeTurn {
  const turnPromise = resolveRuntime().then((runtime) => runtime.startTurn(input));
  return {
    requestId: input.requestId,
    get promptStarted() {
      return turnPromise.then((turn) => turn.promptStarted);
    },
    events: {
      async *[Symbol.asyncIterator]() {
        yield* (await turnPromise).events;
      },
    },
    result: turnPromise.then((turn) => turn.result),
    cancel(inputArgs) {
      return turnPromise.then((turn) => turn.cancel(inputArgs));
    },
    closeStream(inputArgs) {
      return turnPromise.then((turn) => turn.closeStream(inputArgs));
    },
  };
}

/** Create an ACP runtime facade backed by an async runtime resolver. */
export function createLazyAcpRuntimeProxy(
  resolveRuntime: () => Promise<CompleteAcpRuntime>,
): CompleteAcpRuntime {
  return {
    ownerAwareSessions: 1,
    async ensureSession(input) {
      return await (await resolveRuntime()).ensureSession(input);
    },
    startTurn(input) {
      return lazyStartRuntimeTurn(resolveRuntime, input);
    },
    async *runTurn(input) {
      yield* (await resolveRuntime()).runTurn(input);
    },
    async getCapabilities(input) {
      return await (await resolveRuntime()).getCapabilities(input);
    },
    async getStatus(input) {
      return await (await resolveRuntime()).getStatus(input);
    },
    async setMode(input) {
      await (await resolveRuntime()).setMode(input);
    },
    async setConfigOption(input) {
      return await (await resolveRuntime()).setConfigOption(input);
    },
    async doctor() {
      return await (await resolveRuntime()).doctor();
    },
    async prepareFreshSession(input) {
      await (await resolveRuntime()).prepareFreshSession(input);
    },
    async cancel(input) {
      await (await resolveRuntime()).cancel(input);
    },
    async close(input) {
      await (await resolveRuntime()).close(input);
    },
  };
}
