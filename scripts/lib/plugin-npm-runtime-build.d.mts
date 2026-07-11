/** List extension package dirs whose package metadata enables artifact publishing. */
export function listPublishablePluginPackageDirs(params?: Record<string, unknown>): string[];
/** List package-local runtime output files expected from a runtime build plan. */
export function listPluginNpmRuntimeBuildOutputs(plan: unknown): string[];
/** Resolve the package-local runtime build plan for one publishable plugin package. */
export function resolvePluginNpmRuntimeBuildPlan(params: unknown): {
  runtimeBuildOutputs: string[];
  packageFiles: string[];
  packagePeerMetadata: {
    peerDependencies: {
      openclaw: string;
    };
    peerDependenciesMeta: {
      openclaw: { optional: boolean };
    };
  };
  repoRoot: string;
  packageDir: string;
  pluginDir: string;
  packageJson: {
    openclaw: { compat: { pluginApi: string } };
    [key: string]: unknown;
  };
  rootPackageJson: Record<string, unknown>;
  sourceEntries: string[];
  entry: {
    [k: string]: string;
  };
  outDir: string;
  runtimeExtensions: string[];
  runtimeSetupEntry: string | undefined;
} | null;
/** Build package-local runtime files and static assets for one plugin package. */
export function buildPluginNpmRuntime(params: unknown): Promise<{
  assetBuildCommand: string | null;
  copiedStaticAssets: string[];
  runtimeBuildOutputs: string[];
  packageFiles: unknown[];
  packagePeerMetadata: {
    peerDependencies: {
      openclaw: string;
    };
    peerDependenciesMeta: unknown;
  };
  repoRoot: string;
  packageDir: unknown;
  pluginDir: string;
  packageJson: unknown;
  rootPackageJson: unknown;
  sourceEntries: unknown[];
  entry: {
    [k: string]: string;
  };
  outDir: string;
  runtimeExtensions: unknown;
  runtimeSetupEntry: string | undefined;
} | null>;
export function parseArgs(argv: unknown):
  | {
      help: boolean;
      packageDir: string;
    }
  | {
      packageDir: unknown;
      help?: undefined;
    };
