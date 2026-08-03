import type { resolveSkillsInstallPreferences } from "../loading/config.js";
import type { loadWorkspaceSkillEntries } from "../loading/workspace.js";
import "./install.js";

type SkillsInstallDeps = {
  hasBinary(bin: string): boolean;
  loadWorkspaceSkillEntries: typeof loadWorkspaceSkillEntries;
  resolveNodeInstallStateDir(): string;
  resolveBrewExecutable(): string | undefined;
  isContainerEnvironment(): boolean;
  resolveSkillsInstallPreferences: typeof resolveSkillsInstallPreferences;
};

type ResolveDefaultNodeInstallStateDirParams = {
  cwd?: string;
  getuid?: () => number;
  homedir?: () => string;
  platform?: NodeJS.Platform;
};

type SkillsInstallTestApi = {
  resolveDefaultNodeInstallStateDir(params?: ResolveDefaultNodeInstallStateDirParams): string;
  setDepsForTest(overrides?: Partial<SkillsInstallDeps>): void;
};

function getTestApi(): SkillsInstallTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.skillsInstallTestApi")
  ] as SkillsInstallTestApi;
}

export const skillsInstallTesting: SkillsInstallTestApi = {
  resolveDefaultNodeInstallStateDir(params) {
    return getTestApi().resolveDefaultNodeInstallStateDir(params);
  },
  setDepsForTest(overrides) {
    getTestApi().setDepsForTest(overrides);
  },
};
