import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractHookToken,
  isHookAgentAllowed,
  normalizeHookDispatchSessionKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
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
    expect(normalizeWakePayload({ text: "  ", mode: "now" }).ok).toBe(false);
  });

  test("normalizeAgentPayload defaults + validates channel", () => {
    const ok = normalizeAgentPayload({ message: "hello" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionKey).toBeUndefined();
      expect(ok.value.channel).toBe("last");
      expect(ok.value.name).toBe("Hook");
      expect(ok.value.deliver).toBe(true);
    }

    const explicitNoDeliver = normalizeAgentPayload({ message: "hello", deliver: false });
    expect(explicitNoDeliver.ok).toBe(true);
    if (explicitNoDeliver.ok) {
      expect(explicitNoDeliver.value.deliver).toBe(false);
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
    const imsg = normalizeAgentPayload({ message: "yo", channel: "imsg" });
    expect(imsg.ok).toBe(true);
    if (imsg.ok) {
      expect(imsg.value.channel).toBe("imessage");
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
    const aliasChannel = normalizeAgentPayload({ message: "yo", channel: "workspace-chat" });
    expect(aliasChannel.ok).toBe(true);
    if (aliasChannel.ok) {
      expect(aliasChannel.value.channel).toBe("demo-alias-channel");
    }

    const bad = normalizeAgentPayload({ message: "yo", channel: "sms" });
    expect(bad.ok).toBe(false);
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
  });

  test("resolveHookTargetAgentId falls back to default for unknown agent ids", () => {
    const cfg = {
      hooks: { enabled: true, token: "secret" },
      agents: {
        list: [{ id: "main", default: true }, { id: "hooks" }],
      },
    } as OpenClawConfig;
    const resolved = resolveHooksConfigOrThrow(cfg);
    expect(resolveHookTargetAgentId(resolved, "hooks")).toBe("hooks");
    expect(resolveHookTargetAgentId(resolved, "missing-agent")).toBe("main");
    expect(resolveHookTargetAgentId(resolved, undefined)).toBeUndefined();
  });

  test("isHookAgentAllowed honors hooks.allowedAgentIds for explicit routing", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["hooks"]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "missing-agent")).toBe(false);
  });

  test("isHookAgentAllowed treats empty allowlist as deny-all for explicit agentId", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig([]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(false);
    expect(isHookAgentAllowed(resolved, "main")).toBe(false);
  });

  test("isHookAgentAllowed treats wildcard allowlist as allow-all", () => {
    const resolved = resolveHooksConfigOrThrow(buildHookAgentConfig(["*"]));
    expect(isHookAgentAllowed(resolved, undefined)).toBe(true);
    expect(isHookAgentAllowed(resolved, "hooks")).toBe(true);
    expect(isHookAgentAllowed(resolved, "missing-agent")).toBe(true);
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
    const resolved = resolveHooksConfigOrThrow({
      hooks: {
        enabled: true,
        token: "secret",
        mappings: [
          {
            action: "agent",
            messageTemplate: "catch-all",
            sessionKey: "hook:static",
          },
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:{{messages[0].id}}",
          },
        ],
      },
    } as OpenClawConfig);

    expect(resolved.mappings.map((mapping) => mapping.sessionKey)).toEqual([
      "hook:static",
      "hook:gmail:{{messages[0].id}}",
    ]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig ignores templated session keys on wake mappings", () => {
    const resolved = resolveHooksConfigOrThrow({
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
    } as OpenClawConfig);

    expect(resolved.mappings).toHaveLength(1);
    expect(resolved.mappings[0]?.action).toBe("wake");
    expect(resolved.mappings[0]?.matchPath).toBe("wake");
    expect(resolved.mappings[0]?.sessionKey).toBe("hook:wake:{{payload.id}}");
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig treats '/' match.path as a catch-all for shadowing", () => {
    const resolved = resolveHooksConfigOrThrow({
      hooks: {
        enabled: true,
        token: "secret",
        mappings: [
          {
            match: { path: "/" },
            action: "agent",
            messageTemplate: "catch-all",
            sessionKey: "hook:static",
          },
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:{{messages[0].id}}",
          },
        ],
      },
    } as OpenClawConfig);

    expect(resolved.mappings.map((mapping) => mapping.matchPath)).toEqual(["", "gmail"]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });

  test("resolveHooksConfig treats empty match.source as a wildcard for shadowing", () => {
    const resolved = resolveHooksConfigOrThrow({
      hooks: {
        enabled: true,
        token: "secret",
        mappings: [
          {
            match: { path: "gmail", source: "" },
            action: "agent",
            messageTemplate: "catch-all source",
            sessionKey: "hook:static",
          },
          {
            match: { path: "gmail", source: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            sessionKey: "hook:gmail:{{messages[0].id}}",
          },
        ],
      },
    } as OpenClawConfig);

    expect(resolved.mappings.map((mapping) => mapping.matchSource)).toEqual(["", "gmail"]);
    expect(resolved.sessionPolicy.allowedSessionKeyPrefixes).toBeUndefined();
  });
});

const emptyRegistry = createTestRegistry([]);
