// Doctor missing-state e2e tests cover warning output when the state directory is absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  callGateway,
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
} from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let defaultDoctorCommand: typeof import("./doctor.js").doctorCommand;
let reloadDefaultDoctorCommand = false;

const OPENAI_PROVIDER_ID = "openai";
const LEGACY_CODEX_PROVIDER_ID = "openai-codex";
const CODEX_PROFILE_ID = "openai:user@example.com";
const CODEX_PROFILE_EMAIL = "user@example.com";

function configCodexOAuthProfile() {
  return {
    provider: OPENAI_PROVIDER_ID,
    mode: "oauth",
    email: CODEX_PROFILE_EMAIL,
  };
}

function storedCodexOAuthProfile() {
  return {
    type: "oauth",
    provider: OPENAI_PROVIDER_ID,
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    email: CODEX_PROFILE_EMAIL,
  };
}

function mockAuthProfileStore(profiles: Record<string, unknown> = {}): void {
  ensureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles,
  });
}

function mockCodexProviderSnapshot(params: {
  provider: Record<string, unknown>;
  withConfigOAuth?: boolean;
}): void {
  mockDoctorConfigSnapshot({
    config: {
      models: {
        providers: {
          [LEGACY_CODEX_PROVIDER_ID]: params.provider,
        },
      },
      ...(params.withConfigOAuth
        ? {
            auth: {
              profiles: {
                [CODEX_PROFILE_ID]: configCodexOAuthProfile(),
              },
            },
          }
        : {}),
    },
  });
}

async function runDoctorNonInteractive(): Promise<void> {
  await doctorCommand(createDoctorRuntime(), {
    nonInteractive: true,
    workspaceSuggestions: false,
  });
}

function hasCodexOAuthWarning(messageIncludes?: string): boolean {
  return terminalNoteMock.mock.calls.some(
    ([message, title]) =>
      title === "Codex OAuth" &&
      (messageIncludes === undefined || String(message).includes(messageIncludes)),
  );
}

function requireTerminalNote(params: { title?: string; messageIncludes?: string }) {
  const note = terminalNoteMock.mock.calls.find(
    ([message, title]) =>
      (params.title === undefined || title === params.title) &&
      (params.messageIncludes === undefined || String(message).includes(params.messageIncludes)),
  );
  if (!note) {
    throw new Error(
      `expected terminal note${params.title ? ` titled ${params.title}` : ""}${
        params.messageIncludes ? ` containing ${params.messageIncludes}` : ""
      }`,
    );
  }
  return note;
}

function mockDoctorBrowserFastPath(): void {
  vi.doMock("./doctor-browser.js", () => ({
    detectLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue(null),
    maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn().mockResolvedValue({
      changes: [],
      warnings: [],
    }),
    noteChromeMcpBrowserReadiness: vi.fn().mockResolvedValue(undefined),
  }));
}

describe("doctor command", () => {
  beforeAll(async () => {
    defaultDoctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["../flows/doctor-health-contributions.js", "./doctor-state-integrity.js"],
    });
  });

  beforeEach(async () => {
    if (reloadDefaultDoctorCommand) {
      vi.doUnmock("../plugin-sdk/facade-loader.js");
      mockDoctorBrowserFastPath();
      defaultDoctorCommand = await loadDoctorCommandForTest({
        unmockModules: ["../flows/doctor-health-contributions.js", "./doctor-state-integrity.js"],
      });
      reloadDefaultDoctorCommand = false;
    }
    doctorCommand = defaultDoctorCommand;
    terminalNoteMock.mockClear();
  });

  it("warns when the state directory is missing", async () => {
    mockDoctorConfigSnapshot();

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
    fs.rmSync(missingDir, { recursive: true, force: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: missingDir }, async () => {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    });

    const stateNote = requireTerminalNote({ messageIncludes: "state directory missing" });
    expect(String(stateNote[0])).toContain("CRITICAL");
  });

  it("routes browser readiness through health contributions and degrades gracefully when browser facade is unavailable", async () => {
    const loadBundledPluginPublicSurfaceModuleSync = vi.fn(() => {
      throw new Error("missing browser doctor facade");
    });
    vi.doMock("../plugin-sdk/facade-loader.js", async () => {
      const actual = await vi.importActual<typeof import("../plugin-sdk/facade-loader.js")>(
        "../plugin-sdk/facade-loader.js",
      );
      return {
        ...actual,
        loadBundledPluginPublicSurfaceModuleSync,
      };
    });
    try {
      doctorCommand = await loadDoctorCommandForTest({
        unmockModules: [
          "../flows/doctor-health-contributions.js",
          "./doctor-browser.js",
          "./doctor-state-integrity.js",
        ],
      });

      mockDoctorConfigSnapshot({
        config: {
          browser: {
            defaultProfile: "user",
          },
        },
      });

      await runDoctorNonInteractive();

      expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
        dirName: "browser",
        artifactBasename: "browser-doctor.js",
      });
      const browserFallbackNote = requireTerminalNote({
        title: "Browser",
        messageIncludes: "Browser health check is unavailable",
      });
      expect(String(browserFallbackNote[0])).toContain("missing browser doctor facade");
    } finally {
      reloadDefaultDoctorCommand = true;
    }
  });

  it("warns about opencode provider overrides", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            opencode: {
              api: "openai-completions",
              baseUrl: "https://opencode.ai/zen/v1",
            },
            "opencode-go": {
              api: "openai-completions",
              baseUrl: "https://opencode.ai/zen/go/v1",
            },
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(
      ([message, title]) =>
        title === "OpenCode" &&
        String(message).includes("models.providers.opencode") &&
        String(message).includes("models.providers.opencode-go"),
    );
    expect(warned).toBe(true);
  });

  it("warns when a legacy Codex provider override shadows configured Codex OAuth", async () => {
    mockCodexProviderSnapshot({
      provider: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning("models.providers.openai-codex")).toBe(true);
  });

  it("warns when a legacy Codex provider override shadows stored Codex OAuth", async () => {
    mockCodexProviderSnapshot({
      provider: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    mockAuthProfileStore({
      [CODEX_PROFILE_ID]: storedCodexOAuthProfile(),
    });

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning("models.providers.openai-codex")).toBe(true);
  });

  it("warns when an inline OpenAI model keeps the legacy OpenAI transport", async () => {
    mockCodexProviderSnapshot({
      provider: {
        models: [
          {
            id: "gpt-5.4",
            api: "openai-responses",
          },
        ],
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning("legacy transport override")).toBe(true);
  });

  it("does not warn for a custom OpenAI proxy override", async () => {
    mockCodexProviderSnapshot({
      provider: {
        api: "openai-responses",
        baseUrl: "https://custom.example.com",
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning()).toBe(false);
  });

  it("does not warn for header-only OpenAI overrides", async () => {
    mockCodexProviderSnapshot({
      provider: {
        baseUrl: "https://custom.example.com",
        headers: { "X-Custom-Auth": "token-123" },
        models: [{ id: "gpt-5.4" }],
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning()).toBe(false);
  });

  it("does not warn about a legacy Codex provider override without Codex OAuth", async () => {
    mockCodexProviderSnapshot({
      provider: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning()).toBe(false);
  });

  it("skips gateway auth warning when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: { mode: "local" },
      },
    });

    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-1234567890";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }

    const warned = terminalNoteMock.mock.calls.some(([message]) =>
      String(message).includes("Gateway auth is off or missing a token"),
    );
    expect(warned).toBe(false);
  });

  it("warns when token and password are both configured and gateway.auth.mode is unset", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            token: "token-value",
            password: "password-value", // pragma: allowlist secret
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const gatewayAuthNote = requireTerminalNote({ title: "Gateway auth" });
    expect(String(gatewayAuthNote[0])).toContain("gateway.auth.mode is unset");
    expect(String(gatewayAuthNote[0])).toContain("openclaw config set gateway.auth.mode token");
    expect(String(gatewayAuthNote[0])).toContain("openclaw config set gateway.auth.mode password");
  });

  it("keeps doctor read-only when gateway token is SecretRef-managed but unresolved", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    const gatewayAuthNote = requireTerminalNote({ title: "Gateway auth" });
    expect(String(gatewayAuthNote[0])).toContain(
      "Gateway token SecretRef could not be resolved: gateway.auth.token SecretRef is unresolved",
    );
    expect(String(gatewayAuthNote[0])).toContain(
      "Doctor will not overwrite gateway.auth.token with a plaintext value.",
    );
  });

  it("does not let OPENCLAW_GATEWAY_TOKEN hide an unresolved SecretRef-managed token", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_MISSING_GATEWAY_REF_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
    });

    const previousFallbackToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const previousRefToken = process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token-1234567890";
    delete process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousFallbackToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousFallbackToken;
      }
      if (previousRefToken === undefined) {
        delete process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
      } else {
        process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN = previousRefToken;
      }
    }

    const gatewayAuthNote = requireTerminalNote({ title: "Gateway auth" });
    expect(String(gatewayAuthNote[0])).toContain(
      "Gateway token SecretRef could not be resolved: gateway.auth.token SecretRef is unresolved",
    );
  });

  it("skips gateway health probes for exec SecretRefs unless allow-exec is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    callGateway.mockClear();
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips gateway health probes for active exec password SecretRefs", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    callGateway.mockClear();
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips token-mode exec token probes even when env password is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "fallback-password";
    try {
      callGateway.mockClear();
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousPassword === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previousPassword;
      }
    }

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips password-mode exec password probes even when env token is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    try {
      callGateway.mockClear();
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips gateway health probes for ambiguous exec SecretRefs", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/token",
            },
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    callGateway.mockClear();
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips remote exec token probes even when env token fallback is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "https://gateway.example.test",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/remote-token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    try {
      callGateway.mockClear();
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("skips remote probes when local fallback credentials use exec", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "remote",
          auth: {
            mode: "password",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/token",
            },
          },
          remote: {
            url: "https://gateway.example.test",
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    callGateway.mockClear();
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(callGateway).not.toHaveBeenCalled();
    requireTerminalNote({
      title: "Gateway",
      messageIncludes:
        "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
    });
  });

  it("keeps gateway health probes for non-token auth with exec SecretRefs", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: "configured-password",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("keeps gateway health probes when env token wins over an exec password ref", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("keeps gateway health probes when env password wins over an exec password ref", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "fallback-password";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousPassword === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previousPassword;
      }
    }

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("keeps remote gateway health probes when env token wins over an exec password ref", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "remote",
          auth: {
            mode: "password",
          },
          remote: {
            url: "https://gateway.example.test",
            password: {
              source: "exec",
              provider: "default",
              id: "gateway/remote-password",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("keeps remote gateway health probes when env password wins over an exec token ref", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "remote",
          auth: {
            mode: "token",
          },
          remote: {
            url: "https://gateway.example.test",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/remote-token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    const previousPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "fallback-password";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousPassword === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previousPassword;
      }
    }

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("keeps local gateway health probes when only dormant remote refs use exec", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: "configured-token",
          },
          remote: {
            url: "https://gateway.example.test",
            token: {
              source: "exec",
              provider: "default",
              id: "gateway/remote-token",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
            },
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const skippedGatewayHealth = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway" &&
        String(message).includes(
          "Gateway health probes skipped because gateway credentials use an exec SecretRef.",
        )
      );
    });
    expect(skippedGatewayHealth).toBe(false);
  });

  it("skips gateway auth warning when SecretRef-managed token resolves", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
    });

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "resolved-token-1234567890";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    const warned = terminalNoteMock.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway auth" &&
        String(message).includes("Gateway token is managed via SecretRef")
      );
    });
    expect(warned).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
