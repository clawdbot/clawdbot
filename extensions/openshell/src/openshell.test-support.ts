import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";

export function createOpenShellBackendSandboxConfig(): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "openshell",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: ["*"], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

export function createOpenShellRuntimeEntryFixture(runtimeId: string, configLabel = "openclaw") {
  return {
    containerName: runtimeId,
    backendId: "openshell",
    runtimeLabel: runtimeId,
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: configLabel,
    configLabelKind: "Source",
  } as const;
}
