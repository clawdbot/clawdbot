import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveQmdManagerRuntimeConfig, type QmdManagerCreateParams } from "./qmd-manager-base.js";
import { QmdManagerIo } from "./qmd-manager-io.js";

export { resolveQmdMcporterSearchProcessTimeoutMs } from "./qmd-command-client.js";

export class QmdMemoryManager extends QmdManagerIo implements MemorySearchManager {
  static async create(params: QmdManagerCreateParams): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const runtimeConfig =
      params.runtimeConfig ?? resolveQmdManagerRuntimeConfig(params.cfg, params.agentId);
    const manager = new QmdMemoryManager({
      agentId: params.agentId,
      resolved,
      runtimeConfig,
      withLease: params.withLease,
    });
    await manager.initialize(params.mode ?? "full");
    return manager;
  }
}
