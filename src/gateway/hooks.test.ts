// Gateway hooks tests cover token extraction, target agent resolution, payload
// normalization, allowed-agent checks, and channel alias handling.
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractHookToken,
  isHookAgentAllowed,
  normalizeHookDispatchSessionKey,
  resolveEffectiveHookTargetAgentId,
  resolveHookSessionKey,
  normalizeAgentPayload,
  normalizeWakePayload,
  resolveHooksConfig,
} from "./hooks.js";

const createDemoAliasPlugin = () => ({
  ...createChannelTestPluginBase({
    id: "demo-alias-channel",
    label: "Demo Alias Channel",
    docsPath: "/channels/demo-alias-channel",
  }),
  meta: {
    ...createChannelTestPluginBase({
      id: "demo-alias-channel",
      label: "Demo Alias Channel",
      docsPath: "/channels/demo-alias-channel",
    }).meta,
    aliases: ["workspace-chat"],
  },
});

const createIMessageAliasPlugin = () => ({
  ...createChannelTestPluginBase({
    id: "imessage",
    label: "iMessage",
    docsPath: "/channels/imessage",
  }),
});

describe("gateway hooks helpers", () => {
  const resolveHooksConfigOrThrow = (cfg: OpenClawConfig) => {
    const resolved = resolveHooksConfig(cfg);
    if (!resolved) {
      throw new Error("hooks config missing");
    }
    expect(resolved.token).toBe(cfg.hooks?.token);
    return resolved;
  };

  const buildHookAgentConfig = (allowedAgentIds: string[]) =>
    ({
      hooks: {
        enabled: true,
        token: "secret",
        allowedAgentIds,
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "hooks" }],
      },
    }) as OpenClawConfig;

  const buildStaticShadowingMappingConfig = (params: {
    firstMatch?: Partial<{ path: string; source: string }>;
    firstMessageTemplate?: string;
    secondMatch?: Partial<{ path: string; source: string }>;
  }) =>
    ({
      hooks: {
        enabled: true,
        token: "secret",
        mappings: [
          {
            ...(params.firstMatch ? { match: params.firstMatch } : {}),
            action: "agent",
            messageTemplate: params.firstMessageTemplate ?? "catch-all",
            sessionKey: "hook:static",
          },
          {
            match: params.secondMatch ?? { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:{{messages[0].id}}",
          },
        ],
      },
    }) as OpenClawConfig;

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  test("resolveHooksConfig normalizes paths + requires token", () => {
    const base = {
      hooks: {
        enabled: true,
        token: "secret",
        path: "hooks///",
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfig(base);
    expect(resolved?.basePath).toBe("/hooks");
    expect(resolved?.token).toBe("secret");
    expect(resolved?.sessionPolicy.allowRequestSessionKey).toBe(false);
  });

  test("resolveHooksConfig rejects root path", () => {
    const cfg = {
      hooks: { enabled: true, token: "x", path: "/" },
    } as OpenClawConfig;
    expect(() => resolveHooksConfig(cfg)).toThrow("hooks.path may not be '/'");
  });

  test("extractHookToken prefers bearer > header", () => {
    const req = {
      headers: {
        authorization: "Bearer top",
        "x-openclaw-token": "header",
      },
    } as unknown as IncomingMessage;
    const result1 = extractHookToken(req);
    expect(result1).toBe("top");

    const req2 = {
      headers: { "x-openclaw-token": "header" },
    } as unknown as IncomingMessage;
    const result2 = extractHookToken(req2);
    expect(result2).toBe("header");

    const req3 = { headers: {} } as unknown as IncomingMessage;
    const result3 = extractHookToken(req3);
    expect(result3).toBeUndefined();
  });

  test("normalizeWakePayload trims + validates", () => {
    expect(normalizeWakePayload({ text: "  hi " })).toEqual({
      ok: true,
      value: { text: "hi", mode: "now" },
    });
    expect(
      normalizeWakePayload({
        text: "wake later",
        mode: "next-heartbeat",
        sessionKey: "hook:wake:later",
      }),
    ).toEqual({
      ok: true,
      value: {
        text: "wake later",
        mode: "next-heartbeat",
        sessionKey: "hook:wake:later",
      },
    });
    expect(normalizeWakePayload({ text: "  ", mode: "now" }).ok).toBe(false);
    expect(normalizeWakePayload({ text: "wake", agentId: 42 })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
    expect(normalizeWakePayload({ text: "wake", agentId: "  " })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
  });

  test("normalizeAgentPayload defaults + validates channel", () => {
    const ok = normalizeAgentPayload({ message: "hello" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionKey).toBeUndefined();
      expect(ok.value.sessionMode).toBe("isolated");
      expect(ok.value.channel).toBe("last");
      expect(ok.value.name).toBe("Hook");
      expect(ok.value.deliver).toBe(true);
      expect(ok.value.delivery).toEqual({ mode: "none" });
    }

    const explicitNoDeliver = normalizeAgentPayload({ message: "hello", deliver: false });
    expect(explicitNoDeliver.ok).toBe(true);
    if (explicitNoDeliver.ok) {
      expect(explicitNoDeliver.value.deliver).toBe(false);
      expect(explicitNoDeliver.value.delivery).toEqual({ mode: "none" });
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageAliasPlugin(),
        },
      ]),
    );
    const imsg = normalizeAgentPayload({ message: "yo", channel: "imsg", to: "chat-1" });
    expect(imsg.ok).toBe(true);
    if (imsg.ok) {
      expect(imsg.value.channel).toBe("imessage");
      expect(imsg.value.delivery).toEqual({
        mode: "announce",
        channel: "imessage",
        to: "chat-1",
      });
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-alias-channel",
          source: "test",
          plugin: createDemoAliasPlugin(),
        },
      ]),
    );
    const aliasChannel = normalizeAgentPayload({
      message: "yo",
      channel: "workspace-chat",
      to: "room-1",
    });
    expect(aliasChannel.ok).toBe(true);
    if (aliasChannel.ok) {
      expect(aliasChannel.value.channel).toBe("demo-alias-channel");
    }

    const bad = normalizeAgentPayload({ message: "yo", channel: "sms" });
    expect(bad.ok).toBe(false);

    const persistent = normalizeAgentPayload({
      message: "remember",
      sessionMode: "persistent",
    });
    expect(persistent.ok).toBe(true);
    if (persistent.ok) {
      expect(persistent.value.sessionMode).toBe("persistent");
    }

    expect(normalizeAgentPayload({ message: "yo", sessionMode: "shared" })).toEqual({
      ok: false,
      error: "sessionMode must be isolated or persistent",
    });
  });

  test("normalizeAgentPayload binds delivery only to a concrete channel and recipient", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-alias-channel",
          source: "test",
          plugin: createDemoAliasPlugin(),
        },
      ]),
    );
    const omitted = normalizeAgentPayload({ message: "hello" });
    expect(omitted).toMatchObject({
      ok: true,
      value: { channel: "last", to: undefined, delivery: { mode: "none" } },
    });

    const recipientOnly = normalizeAgentPayload({ message: "hello", to: "sensitive-recipient" });
    expect(recipientOnly).toEqual({
      ok: false,
      error: "channel and to must be set together for hook delivery",
    });
    for (const to of [123, "   "]) {
      expect(normalizeAgentPayload({ message: "hello", to })).toEqual({
        ok: false,
        error: "to must be a non-empty string for hook delivery",
      });
    }

    const channelOnly = normalizeAgentPayload({
      message: "hello",
      channel: "demo-alias-channel",
    });
    expect(channelOnly).toEqual({
      ok: false,
      error: "channel and to must be set together for hook delivery",
    });
    expect(
      normalizeAgentPayload({
        message: "hello",
        deliver: false,
        channel: "stale-channel",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        deliver: false,
        channel: "last",
        to: undefined,
        delivery: { mode: "none" },
      },
    });
    expect(
      normalizeAgentPayload({
        message: "hello",
        channel: "last",
        to: "123456",
      }),
    ).toEqual({
      ok: false,
      error: "channel must name a concrete channel for hook delivery",
    });
    expect(
      normalizeAgentPayload({
        message: "hello",
        accountId: "work",
      }),
    ).toEqual({
      ok: false,
      error: "accountId requires channel and to for hook delivery",
    });
    for (const accountId of [123, "   "]) {
      expect(
        normalizeAgentPayload({
          message: "hello",
          channel: "demo-alias-channel",
          to: "123456",
          accountId,
        }),
      ).toEqual({
        ok: false,
        error: "accountId must be a non-empty string for hook delivery",
      });
    }

    const explicit = normalizeAgentPayload({
      message: "hello",
      channel: "demo-alias-channel",
      to: "123456",
      accountId: " work ",
    });
    expect(explicit).toMatchObject({
      ok: true,
      value: {
        channel: "demo-alias-channel",
        to: "123456",
        accountId: "work",
        delivery: {
          mode: "announce",
          channel: "demo-alias-channel",
          to: "123456",
          accountId: "work",
        },
      },
    });
  });

  test("normalizeAgentPayload passes agentId", () => {
    const ok = normalizeAgentPayload({ message: "hello", agentId: "hooks" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.agentId).toBe("hooks");
    }

    const noAgent = normalizeAgentPayload({ message: "hello" });
    expect(noAgent.ok).toBe(true);
    if (noAgent.ok) {
      expect(noAgent.value.agentId).toBeUndefined();
    }

    expect(normalizeAgentPayload({ message: "hello", agentId: 42 })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
    expect(normalizeAgentPayload({ message: "hello", agentId: "  " })).toEqual({
      ok: false,
      error: "agentId must be a non-empty string",
    });
  });

  test("hook target resolution keeps config fallback out of request payloads", () => {
    const cfg = {
      hooks: { enabled: true, token: "secret" },
      agents: {
        list: [{ id: "main", default: true }, { id: "hooks" }],
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);
    expect(resolveEffectiveHookTargetAgentId(resolved, "missing-agent", "mapping")).toEqual({
      ok: true,
      selectedAgentId: "main",
      effectiveAgentId: "main",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "!!!", "mapping")).toEqual({
      ok: true,
      selectedAgentId: "main",
      effectiveAgentId: "main",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "hooks", "request")).toEqual({
      ok: true,
      selectedAgentId: "hooks",
      effectiveAgentId: "hooks",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "missing-agent", "request")).toEqual({
      ok: false,
      code: "unknown-agent",
      agentId: "missing-agent",
      error: 'unknown agentId "missing-agent"',
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "Missing Agent", "request")).toEqual({
      ok: false,
      code: "unknown-agent",
      agentId: "missing-agent",
      error: 'unknown agentId "missing-agent"',
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "!!!", "request")).toEqual({
      ok: false,
      code: "unknown-agent",
      agentId: "!!!",
      error: 'unknown agentId "!!!"',
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toEqual({
      ok: true,
      effectiveAgentId: "main",
    });
  });

  test("global hook dispatch honors the persisted fixed-store owner", () => {
    const resolved = resolveHooksConfigOrThrow({
      hooks: { enabled: true, token: "secret" },
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });

    expect(resolveEffectiveHookTargetAgentId(resolved, undefined, "request")).toEqual({
      ok: true,
      effectiveAgentId: "ops",
    });
    expect(resolveEffectiveHookTargetAgentId(resolved, "research", "request")).toEqual({
      ok: false,
      code: "owner-conflict",
      agentId: "research",
      ownerAgentId: "ops",
      error:
        'agentId "research" conflicts with global session-store owner "ops"; use agentId "ops" or update agents.defaults.sessionStore.agentId',
    });
  });

  test("isHookAgentAllowed honors hooks.allowedAgentIds for effective target routing", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["hooks"]));
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "main")).toBe(false);
  });

  test("isHookAgentAllowed treats empty allowlist as deny-all routing", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig([]));
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(false);
    expect(isHookAgentAllowed(resolved, "main")).toBe(false);
  });

  test("isHookAgentAllowed allows the resolved default agent when allowlisted", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["main"]));
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(false);
    expect(isHookAgentAllowed(resolved, "main")).toBe(true);
  });

  test("isHookAgentAllowed treats wildcard allowlist as allow-all", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["*"]));
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "main")).toBe(true);
  });

  test("resolveHookSessionKey disables request sessionKey by default", () => {
    const cfg = {
      hooks: { enabled: true, token: "secret" },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);
    const denied = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "request",
      sessionKey: "agent:main:dm:u99999",
    });
    expect(denied.ok).toBe(false);
  });

  test("resolveHookSessionKey allows request sessionKey when explicitly enabled", () => {
    const cfg = {
      hooks: { enabled: true, token: "secret", allowRequestSessionKey: true },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);
    const allowed = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "request",
      sessionKey: "hook:manual",
    });
    expect(allowed).toEqual({ ok: true, value: "hook:manual" });
  });

  test("resolveHookSessionKey enforces allowed prefixes", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "secret",
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:"],
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);

    const blocked = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "request",
      sessionKey: "agent:main:main",
    });
    expect(blocked.ok).toBe(false);

    const allowed = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "mapping-static",
      sessionKey: "hook:gmail:1",
    });
    expect(allowed).toEqual({ ok: true, value: "hook:gmail:1" });
  });

  test("resolveHookSessionKey blocks templated mapping sessionKey when request overrides are disabled", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "secret",
        allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"],
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);

    const denied = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "mapping-templated",
      sessionKey: "hook:gmail:attacker",
    });
    expect(denied.ok).toBe(false);
  });

  test("resolveHookSessionKey still allows static mapping sessionKey when request overrides are disabled", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "secret",
        allowedSessionKeyPrefixes: ["hook:", "hook:gmail:"],
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);

    const allowed = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "mapping-static",
      sessionKey: "hook:gmail:fixed",
    });
    expect(allowed).toEqual({ ok: true, value: "hook:gmail:fixed" });
  });

  test("resolveHookSessionKey uses defaultSessionKey when request key is absent", () => {
    const cfg = {
      hooks: {
        enabled: true,
        token: "secret",
        defaultSessionKey: "hook:ingress",
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);

    const resolvedKey = resolveHookSessionKey({
      hooksConfig: resolved,
      source: "request",
    });
    expect(resolvedKey).toEqual({ ok: true, value: "hook:ingress" });
  });

  test("normalizeHookDispatchSessionKey preserves target agent scope", () => {
    expect(
      normalizeHookDispatchSessionKey({
        sessionKey: "agent:hooks:slack:channel:c123",
        targetAgentId: "hooks",
      }),
    ).toBe("agent:hooks:slack:channel:c123");
  });

  test("normalizeHookDispatchSessionKey rebinds non-target agent scoped keys to the target agent", () => {
    expect(
      normalizeHookDispatchSessionKey({
        sessionKey: "agent:main:slack:channel:c123",
        targetAgentId: "hooks",
      }),
    ).toBe("agent:hooks:slack:channel:c123");
  });

  test("resolveHooksConfig validates defaultSessionKey and generated fallback against prefixes", () => {
    expect(() =>
      resolveHooksConfig({
        hooks: {
          enabled: true,
          token: "secret",
          defaultSessionKey: "agent:main:main",
          allowedSessionKeyPrefixes: ["hook:"],
        },
      } as OpenClawConfig),
    ).toThrow("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");

    expect(() =>
      resolveHooksConfig({
        hooks: {
          enabled: true,
          token: "secret",
          allowedSessionKeyPrefixes: ["agent:"],
        },
      } as OpenClawConfig),
    ).toThrow(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  });

  test("resolveHooksConfig requires prefixes for templated mapping session keys", () => {
    expect(() =>
      resolveHooksConfig({
        hooks: {
          enabled: true,
          token: "secret",
          allowRequestSessionKey: true,
          mappings: [
            {
              match: { path: "gmail" },
              action: "agent",
              messageTemplate: "Subject: {{messages[0].subject}}",
              sessionKey: "hook:gmail:{{messages[0].id}}",
            },
          ],
        },
      } as OpenClawConfig),
    ).toThrow(
      "hooks.allowedSessionKeyPrefixes is required when a hook mapping sessionKey uses templates, even if hooks.allowRequestSessionKey=true",
    );
  });

  test("resolveHooksConfig allows a static explicit mapping to shadow the templated gmail preset", () => {
    const resolved = resolveHooksConfigOrThrow({
      hooks: {
        enabled: true,
        token: "secret",
        allowRequestSessionKey: false,
        presets: ["gmail"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:static",
          },
        ],
      },
    } as OpenClawConfig);

    expect(resolved.mappings.map((mapping) => mapping.sessionKey)).toEqual([
      "hook:gmail:static",
      "hook:gmail:{{messages[0].id}}",
    ]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig allows a static catch-all mapping to shadow a later templated mapping", () => {
    const resolved = resolveHooksConfigOrThrow(buildStaticShadowingMappingConfig({}));

    expect(resolved.mappings.map((mapping) => mapping.sessionKey)).toEqual([
      "hook:static",
      "hook:gmail:{{messages[0].id}}",
    ]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig applies templated session-key policy to wake mappings", () => {
    expect(() =>
      resolveHooksConfigOrThrow({
        hooks: {
          enabled: true,
          token: "secret",
          mappings: [
            {
              match: { path: "wake" },
              action: "wake",
              textTemplate: "ping",
              sessionKey: "hook:wake:{{payload.id}}",
            },
          ],
        },
      } as OpenClawConfig),
    ).toThrow("hooks.allowedSessionKeyPrefixes is required");
  });

  test("resolveHooksConfig treats '/' match.path as a catch-all for shadowing", () => {
    const resolved = resolveHooksConfigOrThrow(
      buildStaticShadowingMappingConfig({ firstMatch: { path: "/" } }),
    );

    expect(resolved.mappings.map((mapping) => mapping.matchPath)).toEqual(["", "gmail"]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig treats empty match.source as a wildcard for shadowing", () => {
    const resolved = resolveHooksConfigOrThrow(
      buildStaticShadowingMappingConfig({
        firstMatch: { path: "gmail", source: "" },
        firstMessageTemplate: "catch-all source",
        secondMatch: { path: "gmail", source: "gmail" },
      }),
    );

    expect(resolved.mappings.map((mapping) => mapping.matchSource)).toEqual(["", "gmail"]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });
});

const emptyRegistry = createTestRegistry([]);
