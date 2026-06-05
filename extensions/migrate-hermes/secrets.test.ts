// Migrate Hermes tests cover secrets plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthStorePathForDisplay,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

async function expectMissingPath(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${filePath}`);
}

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

function readAuthProfileStore(agentDir: string): AuthProfileStore {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir);
}

function writeAuthProfileStore(agentDir: string, store: AuthProfileStore): void {
  saveAuthProfileStore(store, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("Hermes migration secret items", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("uses configured agentDir for secret planning and imports without runtime helpers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const customAgentDir = path.join(root, "custom-agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [
          {
            id: "custom",
            default: true,
            agentDir: customAgentDir,
          },
        ],
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
      }),
    );

    expect(plan.metadata?.agentDir).toBe(customAgentDir);
    expect(plan.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: authProfileTarget(customAgentDir, "openai:hermes-import"),
        status: "planned",
        sensitive: true,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);

    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
        overwrite: true,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(customAgentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
      displayName: "Hermes import",
    });
    await expectMissingPath(path.join(stateDir, "agents", "custom", "agent", "auth-profiles.json"));
  });

  it("reports API key import when config update fails after profile write", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async () => {
          throw new Error("config write failed");
        },
      },
    } as unknown as MigrationProviderContext["runtime"];

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime,
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    const item = result.items.find((entry) => entry.id === "secret:openai");
    expect(item).toEqual(
      expect.objectContaining({
        status: "migrated",
        details: expect.objectContaining({
          configUpdated: false,
        }),
      }),
    );
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "openai",
        key: "sk-hermes",
      }),
    );
  });

  it("keeps secret conflict checks read-only during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", provider: "openai", key: "legacy-main-key" },
      }),
    );

    const provider = buildHermesMigrationProvider();
    await provider.plan(makeContext({ source, stateDir, workspaceDir, includeSecrets: true }));

    await expect(fs.access(path.join(agentDir, "auth.json"))).resolves.toBeUndefined();
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports late-created auth profiles as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      includeSecrets: true,
      reportDir,
    });
    const plan = await provider.plan(ctx);
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai:hermes-import": {
          type: "api_key",
          provider: "openai",
          key: "sk-late",
        },
      },
    });

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: authProfileTarget(agentDir, "openai:hermes-import"),
        status: "conflict",
        sensitive: true,
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);
    expect(result.summary.conflicts).toBe(1);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "openai",
        key: "sk-late",
      }),
    );
  });

  it("reports API key config auth profile conflicts during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai:hermes-import": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual([
      expect.objectContaining({
        id: "secret:openai",
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      }),
    ]);

    const result = await provider.apply(ctx, plan);

    expect(result.summary.conflicts).toBe(1);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports late-created API key config auth profile conflicts before writing", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);
    config.auth = {
      profiles: {
        "openai:hermes-import": {
          provider: "anthropic",
          mode: "api_key",
        },
      },
    };

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "secret:openai",
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      }),
    ]);
    expect(result.summary.conflicts).toBe(1);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("imports supported Hermes provider env credentials including OpenCode and GitHub Copilot", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(
      path.join(source, ".env"),
      ["OPENCODE_ZEN_API_KEY=opencode-key", "COPILOT_GITHUB_TOKEN=gho-copilot-token", ""].join(
        "\n",
      ),
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "secret:opencode",
          status: "planned",
          details: expect.objectContaining({
            envVar: "OPENCODE_ZEN_API_KEY",
            provider: "opencode",
            profileId: "opencode:hermes-import",
          }),
        }),
        expect.objectContaining({
          id: "secret:opencode-go",
          status: "planned",
          details: expect.objectContaining({
            envVar: "OPENCODE_ZEN_API_KEY",
            provider: "opencode-go",
            profileId: "opencode-go:hermes-import",
          }),
        }),
        expect.objectContaining({
          id: "secret:github-copilot",
          status: "planned",
          details: expect.objectContaining({
            envVar: "COPILOT_GITHUB_TOKEN",
            mode: "token",
            provider: "github-copilot",
            profileId: "github-copilot:github",
          }),
        }),
      ]),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["opencode:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "opencode",
        key: "opencode-key",
      }),
    );
    expect(authStore.profiles?.["opencode-go:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "opencode-go",
        key: "opencode-key",
      }),
    );
    expect(authStore.profiles?.["github-copilot:github"]).toEqual(
      expect.objectContaining({
        type: "token",
        provider: "github-copilot",
        token: "gho-copilot-token",
      }),
    );
    expect(config.auth?.profiles?.["github-copilot:github"]).toEqual(
      expect.objectContaining({
        provider: "github-copilot",
        mode: "token",
      }),
    );
  });

  it("does not import web-search-only Perplexity env credentials as model auth profiles", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "PERPLEXITY_API_KEY=pplx-hermes\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      includeSecrets: true,
      reportDir,
    });
    const plan = await provider.plan(ctx);

    expect(plan.items.some((item) => item.id === "secret:perplexity")).toBe(false);

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("imports supported OpenCode auth store credentials next to the Hermes home", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, "config.yaml"), "model: opencode/kimi-k2.5\n");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "gho-opencode-copilot-token",
          access: "copilot-api-token",
          expires: Date.now() + 3600_000,
        },
        opencode: {
          type: "api",
          key: "opencode-zen-key",
        },
        "opencode-go": {
          type: "api",
          key: "opencode-go-key",
        },
      }),
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "secret:opencode:opencode-auth-json",
          status: "planned",
          source: path.join(root, ".local", "share", "opencode", "auth.json"),
          details: expect.objectContaining({
            provider: "opencode",
            sourceKind: "opencode-auth-json",
            sourceProvider: "opencode",
            secretField: "key",
          }),
        }),
        expect.objectContaining({
          id: "secret:opencode-go:opencode-auth-json",
          status: "planned",
          details: expect.objectContaining({
            provider: "opencode-go",
            sourceKind: "opencode-auth-json",
            sourceProvider: "opencode-go",
            secretField: "key",
          }),
        }),
        expect.objectContaining({
          id: "secret:github-copilot:opencode-auth-json",
          status: "planned",
          details: expect.objectContaining({
            mode: "token",
            provider: "github-copilot",
            sourceKind: "opencode-auth-json",
            sourceProvider: "github-copilot",
            secretField: "refresh",
          }),
        }),
      ]),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["opencode:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "opencode",
        key: "opencode-zen-key",
      }),
    );
    expect(authStore.profiles?.["opencode-go:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "opencode-go",
        key: "opencode-go-key",
      }),
    );
    expect(authStore.profiles?.["github-copilot:github"]).toEqual(
      expect.objectContaining({
        type: "token",
        provider: "github-copilot",
        token: "gho-opencode-copilot-token",
      }),
    );
  });

  it("skips OpenCode GitHub Copilot enterprise credentials until endpoint routing is supported", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, "config.yaml"), "model: github-copilot/gpt-5.4\n");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "gho-enterprise-copilot-token",
          access: "enterprise-copilot-api-token",
          enterpriseUrl: "https://api.enterprise.githubcopilot.example",
          expires: Date.now() + 3600_000,
        },
      }),
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);

    expect(plan.items.some((item) => item.id === "secret:github-copilot:opencode-auth-json")).toBe(
      false,
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("prefers OpenCode auth from XDG_DATA_HOME when it belongs to the migrated home", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const xdgDataHome = path.join(root, "xdg-data");
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    await writeFile(path.join(source, "config.yaml"), "model: opencode/kimi-k2.5\n");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        opencode: {
          type: "api",
          key: "sibling-opencode-key",
        },
      }),
    );
    await writeFile(
      path.join(xdgDataHome, "opencode", "auth.json"),
      JSON.stringify({
        opencode: {
          type: "api",
          key: "xdg-opencode-key",
        },
      }),
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    try {
      process.env.XDG_DATA_HOME = xdgDataHome;
      const provider = buildHermesMigrationProvider();
      const ctx = makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
        reportDir,
        runtime: makeConfigRuntime(config),
      });
      const plan = await provider.plan(ctx);

      expect(plan.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "secret:opencode:opencode-auth-json",
            source: path.join(xdgDataHome, "opencode", "auth.json"),
            status: "planned",
          }),
        ]),
      );

      const result = await provider.apply(ctx, plan);

      expect(result.summary.errors).toBe(0);
      const authStore = readAuthProfileStore(agentDir);
      expect(authStore.profiles?.["opencode:hermes-import"]).toEqual(
        expect.objectContaining({
          type: "api_key",
          provider: "opencode",
          key: "xdg-opencode-key",
        }),
      );
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it("imports OpenCode OpenAI OAuth credentials as OpenAI auth", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "opencode-openai@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
      },
    });
    await writeFile(path.join(source, "auth.json"), "{}");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: accessToken,
          refresh: "openai-refresh-token",
          expires: Date.now() + 3600_000,
          accountId: "acct_opencode",
        },
      }),
    );
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auth:openai",
          kind: "auth",
          status: "planned",
          source: path.join(root, ".local", "share", "opencode", "auth.json"),
          details: expect.objectContaining({
            provider: "openai",
            sourceKind: "opencode-auth-json",
            sourceLabel: "OpenCode OpenAI OAuth credential",
          }),
        }),
      ]),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:account-acct_opencode"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        accountId: "acct_opencode",
        access: accessToken,
        refresh: "openai-refresh-token",
      }),
    );
  });

  it("does not apply a planned OpenCode OpenAI OAuth credential after the source token changes", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const opencodeAuthPath = path.join(root, ".local", "share", "opencode", "auth.json");
    await writeFile(path.join(source, "auth.json"), "{}");
    await writeFile(
      opencodeAuthPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "planned-opencode-access",
          refresh: "planned-opencode-refresh",
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      includeSecrets: true,
      reportDir,
    });
    const plan = await provider.plan(ctx);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auth:openai",
          details: expect.objectContaining({
            sourceCredentialFingerprint: expect.any(String),
            sourceCredentialIndex: 0,
            sourceKind: "opencode-auth-json",
          }),
        }),
      ]),
    );

    await writeFile(
      opencodeAuthPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "changed-opencode-access",
          refresh: "changed-opencode-refresh",
        },
      }),
    );

    const result = await provider.apply(ctx, plan);
    const authItem = result.items.find((item) => item.id === "auth:openai");

    expect(authItem).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: HERMES_REASON_SECRET_NO_LONGER_PRESENT,
      }),
    );
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports OpenCode OpenAI OAuth config auth profile conflicts during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_conflict",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai:account-acct_conflict": {
            provider: "openai",
            mode: "api_key",
          },
        },
      },
    } as OpenClawConfig;
    await writeFile(path.join(source, "auth.json"), "{}");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: accessToken,
          refresh: "refresh-test-token",
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
      }),
    );
    const authItem = plan.items.find((item) => item.id === "auth:openai");

    expect(authItem).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
        details: expect.objectContaining({
          profileId: "openai:account-acct_conflict",
        }),
      }),
    );
  });

  it("does not collapse OpenCode OpenAI OAuth accounts that share an email", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: sharedEmail },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_new",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    await writeFile(path.join(source, "config.yaml"), "model: openai/gpt-5.5\n");
    await writeFile(
      path.join(root, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: accessToken,
          refresh: "refresh-new-token",
        },
      }),
    );
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai:account-acct_old": {
          type: "oauth",
          provider: "openai",
          access: "old-access-token",
          refresh: "old-refresh-token",
          expires: Date.now() + 3600_000,
          accountId: "acct_old",
          email: sharedEmail,
        },
      },
    });

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);
    const authItem = plan.items.find((item) => item.id === "auth:openai");

    expect(authItem).toEqual(
      expect.objectContaining({
        status: "planned",
        details: expect.objectContaining({
          profileId: "openai:account-acct_new",
        }),
      }),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:account-acct_old"]).toEqual(
      expect.objectContaining({
        access: "old-access-token",
        accountId: "acct_old",
        email: sharedEmail,
      }),
    );
    expect(authStore.profiles?.["openai:account-acct_new"]).toEqual(
      expect.objectContaining({
        access: accessToken,
        accountId: "acct_new",
        email: sharedEmail,
      }),
    );
  });
});
