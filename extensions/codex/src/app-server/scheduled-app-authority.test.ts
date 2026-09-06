import { describe, expect, it, vi } from "vitest";
import {
  createCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import {
  buildPluginAppPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  buildLegacyScheduledCodexAppRecoveryPrompt,
  buildScheduledCodexAppAuthorityInputFingerprint,
  captureScheduledCodexAppAuthority,
  intersectCodexPluginThreadConfigWithScheduledAuthority,
  readCurrentCodexScheduledAppPolicy,
  resolveScheduledCodexAppCreatorCaptureDecision,
} from "./scheduled-app-authority.js";
import { readCodexManagedRequirementsFingerprint } from "./thread-requests.js";

function policyContext() {
  return buildPluginAppPolicyContext(
    {
      calendar: {
        source: "account",
        appName: "Calendar",
        allowDestructiveActions: true,
        allowOpenWorld: true,
        destructiveApprovalMode: "allow",
        mcpServerNames: [],
      },
      disabled: {
        source: "account",
        appName: "Disabled",
        allowDestructiveActions: false,
        allowOpenWorld: false,
        destructiveApprovalMode: "deny",
        mcpServerNames: [],
      },
    },
    {},
  );
}

function authority(overrides?: Record<string, unknown>) {
  return {
    version: 1 as const,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: {
      version: 1,
      auth: { profileId: "openai:work", accountId: "acct-1" },
      apps: [
        {
          id: "calendar",
          allowDestructiveActions: true,
          allowOpenWorld: true,
          destructiveApprovalMode: "allow",
          tools: { list: "auto", edit: "approve" },
        },
      ],
      ...overrides,
    },
  };
}

function threadConfig(): CodexPluginThreadConfig {
  const context = buildPluginAppPolicyContext(
    {
      calendar: {
        source: "account",
        appName: "Calendar",
        allowDestructiveActions: false,
        allowOpenWorld: false,
        destructiveApprovalMode: "ask",
        mcpServerNames: [],
      },
      newly_connected: {
        source: "account",
        appName: "New",
        allowDestructiveActions: true,
        allowOpenWorld: true,
        destructiveApprovalMode: "allow",
        mcpServerNames: [],
      },
    },
    {},
  );
  return {
    enabled: true,
    fingerprint: "current-fingerprint",
    inputFingerprint: "current-input",
    configPatch: { apps: {} },
    provisionalAppIds: ["calendar", "newly_connected"],
    policyContext: context,
    diagnostics: [],
  };
}

describe("scheduled Codex app authority", () => {
  it.each([
    {
      name: "scheduled continuation",
      overrides: { authenticatedScheduledMode: true },
      message: "scheduled Codex continuation",
    },
    {
      name: "supervision",
      overrides: { usesSupervisionConnection: true },
      message: "supervised connection",
    },
    { name: "user home", overrides: { homeScope: "user" }, message: "user-home runtime" },
    {
      name: "missing account identity",
      overrides: {
        hasPreparedAccountIdentity: false,
        hasConfiguredAppServerIdentity: false,
      },
      message: "configured app-server identity",
    },
  ])("refuses creator capture for $name before mutation", ({ overrides, message }) => {
    const decision = resolveScheduledCodexAppCreatorCaptureDecision({
      appsMayBeVisible: true,
      authenticatedScheduledMode: false,
      usesSupervisionConnection: false,
      homeScope: "agent",
      hasPreparedAccountIdentity: true,
      hasConfiguredAppServerIdentity: false,
      ...overrides,
    });

    expect(decision).toMatchObject({ required: true, supported: false });
    expect(decision.unavailableReason).toContain(message);
    expect(decision.unavailableReason).toContain("no automation changes were saved");
  });

  it.each([
    ["prepared profile", true, false],
    ["configured app-server", false, true],
  ])("supports creator capture with a %s identity", (_name, prepared, configured) => {
    expect(
      resolveScheduledCodexAppCreatorCaptureDecision({
        appsMayBeVisible: true,
        authenticatedScheduledMode: false,
        usesSupervisionConnection: false,
        homeScope: "agent",
        hasPreparedAccountIdentity: prepared,
        hasConfiguredAppServerIdentity: configured,
      }),
    ).toEqual({ required: true, supported: true });
  });

  it("captures only connector-backed apps callable on the exact active thread", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "app/installed") {
        expect(params).toEqual({ threadId: "thread-final", forceRefresh: false });
        return {
          apps: [
            { id: "calendar", enabled: true, callable: true },
            { id: "disabled", enabled: false, callable: true },
          ],
        };
      }
      if (method === "mcpServerStatus/list") {
        expect(params).toMatchObject({ threadId: "thread-final", detail: "toolsAndAuthOnly" });
        return {
          data: [
            {
              name: "codex_apps",
              tools: {
                list: { title: "List events", _meta: { connector_id: "calendar" } },
                create: { _meta: { connector_id: "calendar" } },
                unrelated: { _meta: { connector_id: "other" } },
              },
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "config/read") {
        return {
          config: { apps: { calendar: { tools: { "List events": { approval_mode: "writes" } } } } },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const captured = await captureScheduledCodexAppAuthority({
      client: { request } as never,
      threadId: "thread-final",
      policyContext: policyContext(),
      auth: {
        kind: "prepared-profile",
        profileId: "openai:work",
        accountId: "acct-1",
      },
      configCwd: "/workspace",
    });

    expect(captured).toEqual(
      authority({
        apps: [
          {
            id: "calendar",
            allowDestructiveActions: true,
            allowOpenWorld: true,
            destructiveApprovalMode: "allow",
            tools: { create: "approve", list: "writes" },
          },
        ],
      }),
    );
    expect(request).toHaveBeenCalledWith(
      "config/read",
      { includeLayers: false, cwd: "/workspace" },
      expect.any(Object),
    );
  });

  it("does not capture an installed app without exact-thread connector tools", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        return { apps: [{ id: "calendar", enabled: true, callable: true }] };
      }
      if (method === "mcpServerStatus/list") {
        return { data: [{ name: "codex_apps", tools: {} }], nextCursor: null };
      }
      return { config: {} };
    });

    await expect(
      captureScheduledCodexAppAuthority({
        client: { request } as never,
        threadId: "thread-final",
        policyContext: policyContext(),
        auth: {
          kind: "prepared-profile",
          profileId: "openai:work",
          accountId: "acct-1",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("bounds creator capture when a later connector inventory page hangs", async () => {
    let statusPage = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        return { apps: [{ id: "calendar", enabled: true, callable: true }] };
      }
      if (method === "config/read") {
        return { config: {} };
      }
      if (method === "mcpServerStatus/list") {
        statusPage += 1;
        if (statusPage === 1) {
          return { data: [], nextCursor: "page-2" };
        }
        return await new Promise<never>(() => {});
      }
      throw new Error(`unexpected method ${method}`);
    });
    const startedAt = Date.now();

    await expect(
      captureScheduledCodexAppAuthority({
        client: { request } as never,
        threadId: "thread-final",
        policyContext: policyContext(),
        auth: {
          kind: "prepared-profile",
          profileId: "openai:work",
          accountId: "acct-1",
        },
        timeoutMs: 100,
      }),
    ).rejects.toThrow(
      "Codex app authority capture exceeded its 100 ms total budget. No automation changes were saved",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(statusPage).toBe(2);
  });

  it("maps a real app-server request timeout to the no-save creator diagnostic", async () => {
    const timeout = Object.assign(new Error("mcpServerStatus/list timed out"), {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      reason: "timed out",
      mayHaveWritten: false,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "mcpServerStatus/list") {
        throw timeout;
      }
      if (method === "app/installed") {
        return { apps: [] };
      }
      return { config: {} };
    });

    await expect(
      captureScheduledCodexAppAuthority({
        client: { request } as never,
        threadId: "thread-final",
        policyContext: policyContext(),
        auth: {
          kind: "prepared-profile",
          profileId: "openai:work",
          accountId: "acct-1",
        },
      }),
    ).rejects.toThrow("No automation changes were saved");
  });

  it("captures configured app-server authority without a prepared ChatGPT account", async () => {
    const managedRequirements = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        return { apps: [{ id: "calendar", enabled: true, callable: true }] };
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "codex_apps",
              tools: { list: { _meta: { connector_id: "calendar" } } },
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "config/read") {
        return { config: {} };
      }
      if (method === "configRequirements/read") {
        return { requirements: managedRequirements };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const managedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request,
    } as never);

    await expect(
      captureScheduledCodexAppAuthority({
        client: { request } as never,
        threadId: "thread-final",
        policyContext: policyContext(),
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: "configured-connection",
        },
      }),
    ).resolves.toEqual(
      authority({
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: "configured-connection",
          managedRequirementsFingerprint,
        },
        apps: [
          {
            id: "calendar",
            allowDestructiveActions: true,
            allowOpenWorld: true,
            destructiveApprovalMode: "allow",
            tools: { list: "approve" },
          },
        ],
      }),
    );
  });

  it("intersects stored and current app/tool authority without admitting new apps", () => {
    const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
      threadConfig(),
      authority(),
      {
        config: {
          apps: {
            newly_connected: { enabled: true, default_tools_approval_mode: "approve" },
            calendar: {
              tools: {
                list: { approval_mode: "writes" },
                edit: { approval_mode: "writes" },
                newly_added: { approval_mode: "prompt" },
              },
            },
          },
        },
        toolsByApp: new Map([
          [
            "calendar",
            new Map([
              ["list", {}],
              ["edit", {}],
              ["newly_added", {}],
            ]),
          ],
        ]),
      },
    );

    expect(intersected.provisionalAppIds).toEqual(["calendar"]);
    expect(intersected.policyContext.apps).toEqual({
      calendar: expect.objectContaining({
        allowDestructiveActions: false,
        allowOpenWorld: false,
        destructiveApprovalMode: "ask",
      }),
    });
    expect(intersected.configPatch).toMatchObject({
      apps: {
        newly_connected: { enabled: false },
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        calendar: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: false,
          approvals_reviewer: "user",
          tools: {
            list: { enabled: false, approval_mode: "prompt" },
            edit: { enabled: false, approval_mode: "prompt" },
            newly_added: { enabled: false, approval_mode: "prompt" },
          },
        },
      },
    });
  });

  it.each([
    { current: "ask", captured: "allow" },
    { current: "allow", captured: "ask" },
  ] as const)(
    "keeps link approvals with the user for current $current and captured $captured policy",
    ({ current, captured }) => {
      const config = threadConfig();
      config.policyContext.apps.calendar = {
        source: "account",
        appName: "Calendar",
        mcpServerNames: [],
        allowDestructiveActions: true,
        allowOpenWorld: true,
        destructiveApprovalMode: current,
      };
      config.configPatch = {
        apps: {
          calendar: {
            enabled: true,
            ...(current === "ask"
              ? {
                  links: {
                    account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" },
                  },
                }
              : {}),
          },
          newly_connected: { enabled: true },
        },
      };
      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        authority({
          apps: [
            {
              id: "calendar",
              allowDestructiveActions: true,
              allowOpenWorld: true,
              destructiveApprovalMode: captured,
              tools: { edit: "approve", blocked: "approve" },
            },
          ],
        }),
        {
          config: {
            apps: {
              calendar: {
                enabled: true,
                links: {
                  account: {
                    approvals_reviewer: "auto_review",
                    default_tools_approval_mode: "approve",
                  },
                },
                tools: {
                  edit: { approval_mode: "approve" },
                  blocked: { enabled: false, approval_mode: "approve" },
                },
              },
              newly_connected: { enabled: true },
            },
          },
          toolsByApp: new Map([
            [
              "calendar",
              new Map([
                ["edit", {}],
                ["blocked", {}],
              ]),
            ],
          ]),
        },
      );

      expect(intersected.provisionalAppIds).toEqual(["calendar"]);
      expect(intersected.configPatch).toMatchObject({
        apps: {
          calendar: {
            approvals_reviewer: "user",
            links: {
              account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" },
            },
            tools: {
              edit: { enabled: true, approval_mode: "prompt" },
              blocked: { enabled: false, approval_mode: "prompt" },
            },
          },
          newly_connected: { enabled: false },
        },
      });
    },
  );

  it.each([
    {
      name: "explicit tool disablement",
      appConfig: {
        default_tools_enabled: true,
        tools: { edit: { enabled: false } },
      },
      expectedEnabled: false,
    },
    {
      name: "app default disablement",
      appConfig: { default_tools_enabled: false },
      expectedEnabled: false,
    },
    {
      name: "app destructive restriction with unknown annotations",
      appConfig: { destructive_enabled: false },
      expectedEnabled: false,
    },
    {
      name: "app open-world restriction with unknown annotations",
      appConfig: { open_world_enabled: false },
      expectedEnabled: false,
    },
    {
      name: "explicit tool enablement over app default disablement",
      appConfig: {
        default_tools_enabled: false,
        tools: { edit: { enabled: true } },
      },
      expectedEnabled: true,
    },
    {
      name: "explicit tool enablement over current app hint defaults",
      appConfig: {
        destructive_enabled: false,
        open_world_enabled: false,
        tools: { edit: { enabled: true } },
      },
      expectedEnabled: true,
    },
    {
      name: "title-keyed enablement over app default disablement",
      appConfig: {
        default_tools_enabled: false,
        tools: { "Edit event": { enabled: true } },
      },
      expectedEnabled: true,
    },
    {
      name: "title-keyed disablement over app default enablement",
      appConfig: {
        default_tools_enabled: true,
        tools: { "Edit event": { enabled: false } },
      },
      expectedEnabled: false,
    },
    {
      name: "full-name disablement over title-keyed enablement",
      appConfig: {
        default_tools_enabled: true,
        tools: { edit: { enabled: false }, "Edit event": { enabled: true } },
      },
      expectedEnabled: false,
    },
    {
      name: "full-name entry without enablement over title-keyed enablement",
      appConfig: {
        default_tools_enabled: false,
        tools: { edit: { approval_mode: "prompt" }, "Edit event": { enabled: true } },
      },
      expectedEnabled: false,
    },
  ])("preserves $name from the current Codex config", ({ appConfig, expectedEnabled }) => {
    const config = threadConfig();
    config.policyContext = policyContext();
    const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
      config,
      authority(),
      {
        config: { apps: { calendar: appConfig } },
        toolsByApp: new Map([["calendar", new Map([["edit", { title: "Edit event" }]])]]),
      },
    );

    expect(intersected.configPatch).toMatchObject({
      apps: {
        calendar: {
          tools: {
            edit: { enabled: expectedEnabled },
          },
        },
      },
    });
  });

  it.each(["stored", "current"] as const)(
    "keeps %s app caps authoritative over explicit tool enablement",
    async (owner) => {
      const config = threadConfig();
      if (owner === "stored") {
        config.policyContext = policyContext();
      }
      const stored = authority();
      if (owner === "stored") {
        for (const app of stored.payload.apps) {
          app.allowDestructiveActions = false;
          app.allowOpenWorld = false;
        }
      }
      const currentPolicy = await readCurrentCodexScheduledAppPolicy({
        request: async (method) =>
          method === "config/read"
            ? {
                config: {
                  apps: {
                    calendar: {
                      default_tools_enabled: true,
                      tools: { destructive: { enabled: true } },
                    },
                  },
                },
              }
            : {
                data: [
                  {
                    name: "codex_apps",
                    tools: {
                      newly_benign: {
                        _meta: { connector_id: "calendar" },
                        annotations: { destructiveHint: false, openWorldHint: false },
                      },
                      destructive: {
                        _meta: { connector_id: "calendar" },
                        annotations: { destructiveHint: true, openWorldHint: false },
                      },
                      open_world: {
                        _meta: { connector_id: "calendar" },
                        annotations: { destructiveHint: false, openWorldHint: true },
                      },
                      unannotated: { _meta: { connector_id: "calendar" } },
                    },
                  },
                ],
                nextCursor: null,
              },
      });

      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        stored,
        currentPolicy,
      );

      expect(intersected.configPatch).toMatchObject({
        apps: {
          calendar: {
            tools: {
              newly_benign: { enabled: true },
              destructive: { enabled: false },
              open_world: { enabled: false },
              unannotated: { enabled: false },
            },
          },
        },
      });
    },
  );

  it.each([
    { name: "global default", app: {}, expected: "prompt" },
    {
      name: "app default over global default",
      app: { default_tools_approval_mode: "writes" },
      expected: "writes",
    },
    {
      name: "tool override over app default",
      app: {
        default_tools_approval_mode: "prompt",
        tools: { edit: { approval_mode: "approve" } },
      },
      expected: "approve",
    },
  ])("preserves approval $name during capture and continuation", async ({ app, expected }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "app/installed") {
        return { apps: [{ id: "calendar", enabled: true, callable: true }] };
      }
      if (method === "config/read") {
        return {
          config: {
            apps: { _default: { default_tools_approval_mode: "prompt" }, calendar: app },
          },
        };
      }
      return {
        data: [{ name: "codex_apps", tools: { edit: { _meta: { connector_id: "calendar" } } } }],
        nextCursor: null,
      };
    });
    const captured = await captureScheduledCodexAppAuthority({
      client: { request } as never,
      threadId: "thread-final",
      policyContext: policyContext(),
      auth: { kind: "prepared-profile", profileId: "openai:work", accountId: "acct-1" },
    });
    expect(captured).toMatchObject({ payload: { apps: [{ tools: { edit: expected } }] } });

    const config = threadConfig();
    config.policyContext = policyContext();
    const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
      config,
      authority(),
      await readCurrentCodexScheduledAppPolicy({ request }),
    );
    expect(intersected.configPatch).toMatchObject({
      apps: { calendar: { tools: { edit: { approval_mode: expected } } } },
    });
  });

  it("removes tools missing from current inventory and rotates the fingerprint", () => {
    const full = intersectCodexPluginThreadConfigWithScheduledAuthority(
      threadConfig(),
      authority(),
      {
        config: {},
        toolsByApp: new Map([
          [
            "calendar",
            new Map([
              ["list", {}],
              ["edit", {}],
            ]),
          ],
        ]),
      },
    );
    const narrowed = intersectCodexPluginThreadConfigWithScheduledAuthority(
      threadConfig(),
      authority(),
      {
        config: {},
        toolsByApp: new Map([["calendar", new Map([["list", {}]])]]),
      },
    );

    expect(narrowed.configPatch).toMatchObject({
      apps: { calendar: { tools: { list: expect.any(Object) } } },
    });
    const narrowedApps = narrowed.configPatch?.apps as
      | Record<string, { tools?: unknown }>
      | undefined;
    expect(narrowedApps?.calendar?.tools).not.toHaveProperty("edit");
    expect(narrowed.fingerprint).not.toBe(full.fingerprint);
  });

  it("fails before execution when a captured app has no current connector tools", () => {
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(threadConfig(), authority(), {
        config: {},
        toolsByApp: new Map(),
      }),
    ).toThrow("Scheduled Codex apps are unavailable under the current policy or account: calendar");
  });

  it.each([
    { mode: "allow" as const, expected: "approve" },
    { mode: "ask" as const, expected: "prompt" },
    { mode: "auto" as const, expected: "auto" },
  ])("maps an app-level $mode ceiling to headless tool mode $expected", ({ mode, expected }) => {
    const context = buildPluginAppPolicyContext(
      {
        calendar: {
          source: "account",
          appName: "Calendar",
          allowDestructiveActions: true,
          allowOpenWorld: true,
          destructiveApprovalMode: mode,
          mcpServerNames: [],
        },
      },
      {},
    );
    const config: CodexPluginThreadConfig = {
      enabled: true,
      fingerprint: "current",
      inputFingerprint: "input",
      policyContext: context,
      diagnostics: [],
    };

    const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
      config,
      authority(),
      {
        config: {},
        toolsByApp: new Map([["calendar", new Map([["edit", {}]])]]),
      },
    );

    expect(intersected.configPatch).toMatchObject({
      apps: { calendar: { tools: { edit: { enabled: true, approval_mode: expected } } } },
    });
  });

  it("rotates the input fingerprint when the stored cap changes", () => {
    const first = buildScheduledCodexAppAuthorityInputFingerprint("base", authority());
    const second = buildScheduledCodexAppAuthorityInputFingerprint(
      "base",
      authority({
        apps: [
          {
            id: "calendar",
            allowDestructiveActions: false,
            allowOpenWorld: false,
            destructiveApprovalMode: "deny",
            tools: {},
          },
        ],
      }),
    );

    expect(first).not.toBe("base");
    expect(second).not.toBe(first);
    expect(buildScheduledCodexAppAuthorityInputFingerprint("base", undefined)).toBe("base");
  });

  it("fails closed for unknown or malformed Codex authority", () => {
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(threadConfig(), {
        ...authority(),
        namespace: "codex.unknown",
      }),
    ).toThrow(/Unsupported Codex scheduled authority namespace/);
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(
        threadConfig(),
        authority({ apps: [{ id: "calendar" }] }),
      ),
    ).toThrow(/Stored Codex app authority is invalid/);
  });

  it("reports captured app ids omitted by current policy without exposing the envelope", () => {
    const config = threadConfig();
    delete config.policyContext.apps.calendar;

    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(config, authority()),
    ).toThrow(
      "Scheduled Codex apps are unavailable under the current policy or account: calendar. Restore access or reauthorize the automation from a fresh authenticated Codex owner turn.",
    );
  });

  it("gives legacy scheduled caps a bounded operator recovery instruction", () => {
    const prompt = buildLegacyScheduledCodexAppRecoveryPrompt({
      trigger: "cron",
      scheduledRuntimeAuthorityRecoveryRequired: true,
    });

    expect(prompt).toContain("recreate or reauthorize");
    expect(prompt).toContain("authenticated Codex owner turn");
    expect(prompt).not.toContain("account-1");
    expect(
      buildLegacyScheduledCodexAppRecoveryPrompt({
        trigger: "user",
        scheduledRuntimeAuthorityRecoveryRequired: true,
      }),
    ).toBeUndefined();
  });

  it("requires a deny-default app config for scheduled authority even when native tools are enabled", () => {
    const startup = resolveCodexPluginThreadConfigStartupPolicy({
      pluginConfig: {},
      nativeToolSurfaceEnabled: true,
      scheduledRuntimeAuthority: authority(),
    });

    expect(startup.pluginThreadConfigRequired).toBe(true);
    expect(startup.resolvedPluginPolicy).toBeDefined();
  });

  it("bounds hanging current-policy inventory under the total startup deadline", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {} };
      }
      if (method === "mcpServerStatus/list") {
        return await new Promise<never>(() => {});
      }
      throw new Error(`unexpected method ${method}`);
    });
    const provider = createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: "scheduled-input",
      enabledPluginConfigKeys: [],
      policy: undefined,
      requestTimeoutMs: 400,
      signal: new AbortController().signal,
      pluginConfig: {},
      client: { request } as never,
      appCacheKey: "account-1",
      scheduledRuntimeAuthority: authority(),
    });
    const startedAt = Date.now();

    await expect(provider.build()).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message: expect.stringContaining("Codex app policy verification exceeded"),
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "mcpServerStatus/list",
    ]);
  });

  it("reads current policy from the exact existing thread when supplied", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "config/read") {
        return { config: {} };
      }
      if (method === "mcpServerStatus/list") {
        expect(params).toMatchObject({
          threadId: "thread-existing",
          detail: "toolsAndAuthOnly",
        });
        return {
          data: [
            {
              name: "codex_apps",
              tools: { list: { _meta: { connector_id: "calendar" } } },
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const provider = createCodexPluginThreadConfigStartupProvider({
      inputFingerprint: "scheduled-input",
      enabledPluginConfigKeys: [],
      policy: undefined,
      requestTimeoutMs: 2_000,
      signal: new AbortController().signal,
      pluginConfig: {},
      client: { request } as never,
      appCacheKey: "account-1",
      scheduledRuntimeAuthority: authority(),
    });

    await expect(provider.build({ threadId: "thread-existing" })).rejects.toThrow(
      "Scheduled Codex apps are unavailable under the current policy or account: calendar",
    );
    expect(request).toHaveBeenCalledWith(
      "mcpServerStatus/list",
      expect.objectContaining({ threadId: "thread-existing" }),
      expect.any(Object),
    );
  });
});
