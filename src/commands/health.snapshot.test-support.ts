import type { collectGatewayHealthSnapshot } from "../gateway/health/collector.js";
import type { HealthSummary } from "../gateway/health/types.js";

export type LegacyHealthSnapshotParams = Partial<
  Omit<Parameters<typeof collectGatewayHealthSnapshot>[0], "audience">
> & {
  includeSensitive?: boolean;
};

export function createLegacyHealthSnapshotCollector(
  collectSnapshot: typeof collectGatewayHealthSnapshot,
) {
  return (params: LegacyHealthSnapshotParams = {}): Promise<HealthSummary> => {
    const { includeSensitive, probe, ...rest } = params;
    return collectSnapshot({
      ...rest,
      audience: includeSensitive === false ? "public" : "admin",
      probe: probe !== false,
    });
  };
}
