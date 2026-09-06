import type { CloudWorkersConfig } from "../config/types.cloud-workers.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

export function collectConfiguredWorkerProviderIds(config: {
  cloudWorkers?: CloudWorkersConfig;
}): string[] {
  return normalizeWorkerProviderIds(
    Object.values(config.cloudWorkers?.profiles ?? {}).map((profile) => profile.provider),
  );
}
