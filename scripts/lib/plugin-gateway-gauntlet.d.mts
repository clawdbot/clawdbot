export function collectQaBaselineRegressionObservations(
  rows: unknown,
  thresholds?: Record<string, unknown>,
): (
  | {
      kind: string;
      pluginId: unknown;
      cpuCoreRatio: unknown;
      baselineCpuCoreRatio: unknown;
      multiplier: unknown;
      wallMs?: undefined;
      baselineWallMs?: undefined;
    }
  | {
      kind: string;
      pluginId: unknown;
      wallMs: unknown;
      baselineWallMs: unknown;
      multiplier: unknown;
      cpuCoreRatio?: undefined;
      baselineCpuCoreRatio?: undefined;
    }
)[];
export type PluginGatewayEntry = {
  id: string;
  requiredPlugins?: string[];
};
export function collectPluginsWithRequiredEntries<T extends PluginGatewayEntry>(
  entries: T[],
  plugins: T[],
): T[];
export function collectRequiredPluginEntries<T extends PluginGatewayEntry>(
  entries: T[],
  plugins: T[],
): T[];
export function collectGatewayCpuObservations(params: unknown): (
  | {
      kind: string;
      id: string;
      cpuCoreRatioMax: number;
      wallMsMax: number;
      cpuCoreRatio?: undefined;
      wallMs?: undefined;
    }
  | {
      kind: string;
      id: string;
      cpuCoreRatio: number;
      wallMs: number;
      cpuCoreRatioMax?: undefined;
      wallMsMax?: undefined;
    }
)[];
export function collectMetricObservations(
  rows: unknown,
  thresholds?: Record<string, unknown>,
): (
  | {
      coldStart?: true | undefined;
      kind: string;
      pluginId: unknown;
      phase: unknown;
      cpuCoreRatio: number;
      wallMs: number;
    }
  | {
      coldStart?: true | undefined;
      kind: string;
      pluginId: unknown;
      phase: unknown;
      wallMs: unknown;
      medianWallMs: unknown;
      multiplier: unknown;
    }
  | {
      coldStart?: true | undefined;
      kind: string;
      pluginId: unknown;
      phase: unknown;
      maxRssMb: unknown;
      thresholdMb: number;
    }
  | {
      coldStart?: true | undefined;
      kind: string;
      pluginId: unknown;
      phase: unknown;
      maxRssMb: unknown;
      medianRssMb: unknown;
      multiplier: unknown;
    }
)[];
export function buildGauntletPrebuildEnv(env: unknown, options?: Record<string, unknown>): unknown;
export function detectCommandDiagnosticFailure(
  stdout: unknown,
  stderr: unknown,
): "plugin-load-failure" | null;
export function discoverBundledPluginManifests(repoRoot: unknown): {
  id: unknown;
  buildId: string;
  name: unknown;
  dir: string;
  manifestPath: string;
  enabledByDefault: boolean;
  activation: unknown;
  providers: string[];
  channels: string[];
  skills: string[];
  authMethods: unknown;
  onboardingScopes: unknown[];
  requiredPlugins: string[];
  hasConfigSchema: boolean;
  hasRequiredConfigFields: boolean;
  commandAliases: unknown;
  cliCommandAliases: unknown;
  runtimeSlashAliases: unknown;
}[];
export function readQaSuiteSummary(summaryPath: unknown):
  | {
      diagnosticFailure: string;
      diagnosticDetail: string;
      summary: unknown;
    }
  | {
      diagnosticFailure: null;
      diagnosticDetail: null;
      summary: unknown;
    };
export function selectPluginEntries<T extends PluginGatewayEntry>(
  entries: T[],
  options?: { ids?: string[]; shardIndex?: number; shardTotal?: number },
): T[];
