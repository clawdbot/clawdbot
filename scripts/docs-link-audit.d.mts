export type BrokenDocLink = {
  file: string;
  line: number;
  link: string;
  reason: string;
};

export type ResolveRouteResult = {
  ok: boolean;
  terminal: string;
  loop?: boolean;
};

export type MirroredDocsDir = {
  cleanup: () => void;
  dir: string;
  mirroredClawHub: boolean;
};

export type ScriptSpawnOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  stdio: string;
};

export type ScriptSpawnResult = {
  status: number | null;
  error?: { code?: string };
};

export type ScriptSpawn = (
  command: string,
  args: string[],
  options: ScriptSpawnOptions,
) => ScriptSpawnResult;

export type ScriptInvocation = {
  command: string;
  args: string[];
  options?: Partial<ScriptSpawnOptions> & {
    detached?: boolean;
    windowsVerbatimArguments?: boolean;
  };
};

export function normalizeRoute(route: string): string;
export function resolveRoute(
  route: string,
  options?: { redirects?: Map<string, string>; routes?: Set<string> },
): ResolveRouteResult;

export function sanitizeDocsConfigForEnglishOnly(value: unknown): unknown;

export function prepareMirroredDocsDir(
  sourceDir?: string,
  options?: {
    resolveClawHubRepoPathImpl?: (
      value?: string,
      options?: { required?: boolean },
    ) => string | undefined;
    syncClawHubDocsTreeImpl?: (
      targetDocsDir: string,
      options?: { repoPath?: string; required?: boolean },
    ) => unknown;
  },
): MirroredDocsDir;

export function prepareAnchorAuditDocsDir(sourceDir?: string): string;

export function resolveMintlifyAnchorAuditInvocation(params: {
  cwd: string;
  nodeVersion?: string;
  spawnSyncImpl: ScriptSpawn;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
}): ScriptInvocation;

export function auditDocsLinks(options?: {
  docsDir?: string;
  allowExternalClawHubRoutes?: boolean;
}): {
  checked: number;
  broken: BrokenDocLink[];
};

export function runDocsLinkAuditCli(options?: {
  args?: string[];
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  nodeVersion?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: ScriptSpawn;
  prepareAnchorAuditDocsDirImpl?: (sourceDir?: string) => string;
  prepareMirroredDocsDirImpl?: (sourceDir?: string) => MirroredDocsDir;
  cleanupAnchorAuditDocsDirImpl?: (dir: string) => void;
}): number;
