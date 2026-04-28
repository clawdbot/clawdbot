import type {
  SandboxBrowserConfig,
  SandboxPruneConfig,
  SandboxSshConfig,
} from "../../agents/sandbox/types.js";

export function createSandboxBrowserConfig(
  overrides: Partial<SandboxBrowserConfig> = {},
): SandboxBrowserConfig {
  return {
    enabled: false,
    image: "openclaw-browser",
    containerPrefix: "openclaw-browser-",
    network: "bridge",
    cdpPort: 9222,
    vncPort: 5900,
    noVncPort: 6080,
    headless: true,
    enableNoVnc: false,
    allowHostControl: false,
    autoStart: false,
    autoStartTimeoutMs: 1000,
    ...overrides,
  };
}

export function createSandboxPruneConfig(
  overrides: Partial<SandboxPruneConfig> = {},
): SandboxPruneConfig {
  return {
    idleHours: 24,
    maxAgeDays: 7,
    ...overrides,
  };
}

export function createSandboxSshConfig(
  workspaceRoot: string,
  overrides: Partial<SandboxSshConfig> = {},
): SandboxSshConfig {
  return {
    command: "ssh",
    workspaceRoot,
    strictHostKeyChecking: true,
    updateHostKeys: true,
    ...overrides,
  };
}
