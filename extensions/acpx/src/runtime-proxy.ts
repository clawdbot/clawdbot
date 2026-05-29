import type { AcpRuntime } from "../runtime-api.js";
import { lazyStartRuntimeTurn } from "./runtime-turn.js";

export function createLazyAcpRuntimeProxy<T extends AcpRuntime>(
  resolveRuntime: () => Promise<T>,
): AcpRuntime {
  return {
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
      return (await (await resolveRuntime()).getCapabilities?.(input)) ?? { controls: [] };
    },
    async getStatus(input) {
      return (await (await resolveRuntime()).getStatus?.(input)) ?? {};
    },
    async setMode(input) {
      await (await resolveRuntime()).setMode?.(input);
    },
    async setConfigOption(input) {
      await (await resolveRuntime()).setConfigOption?.(input);
    },
    async doctor() {
      return (await (await resolveRuntime()).doctor?.()) ?? { ok: true, message: "ok" };
    },
    async prepareFreshSession(input) {
      await (await resolveRuntime()).prepareFreshSession?.(input);
    },
    async cancel(input) {
      await (await resolveRuntime()).cancel(input);
    },
    async close(input) {
      await (await resolveRuntime()).close(input);
    },
  };
}
