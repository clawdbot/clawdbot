import { vi } from "vitest";

vi.mock("./doctor-completion.js", () => ({
  doctorShellCompletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-bootstrap-size.js", () => ({
  noteBootstrapFileSize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-browser.js", () => ({
  noteChromeMcpBrowserReadiness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-claude-cli.js", () => ({
  noteClaudeCliHealth: vi.fn(),
}));

vi.mock("./doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-gateway-health.js", () => ({
  checkGatewayHealth: vi.fn().mockResolvedValue({ healthOk: false }),
  probeGatewayMemoryStatus: vi
    .fn()
    .mockResolvedValue({ checked: false, ready: false, skipped: false }),
}));

vi.mock("./doctor-memory-search.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: vi.fn(),
  noteMacLaunchAgentOverrides: vi.fn().mockResolvedValue(undefined),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-sandbox.js", () => ({
  maybeRepairSandboxImages: vi.fn(async (cfg: unknown) => cfg),
  maybeRepairSandboxRegistryFiles: vi.fn().mockResolvedValue(undefined),
  noteSandboxScopeWarnings: vi.fn(),
}));

vi.mock("./doctor-security.js", () => ({
  noteSecurityWarnings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-locks.js", () => ({
  noteSessionLockHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-transcripts.js", () => ({
  noteSessionTranscriptHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-state-integrity.js", () => ({
  noteStateIntegrity: vi.fn().mockResolvedValue(undefined),
  noteWorkspaceBackupTip: vi.fn(),
}));

vi.mock("./doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: vi.fn(),
}));

vi.mock("./oauth-tls-preflight.js", () => ({
  noteOpenAIOAuthTlsPrerequisites: vi.fn().mockResolvedValue(undefined),
}));
