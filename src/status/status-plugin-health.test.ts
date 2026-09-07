// Plugin health status tests cover compact and detailed chat formatting.
import { describe, expect, it } from "vitest";
import {
  formatCompactPluginHealthLine,
  formatDetailedPluginHealth,
  mergeStatusPluginHealthSnapshots,
  type StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

const emptySnapshot: StatusPluginHealthSnapshot = {
  plugins: [],
  diagnostics: [],
  contextEngineQuarantines: [],
};

describe("plugin health status formatting", () => {
  it("omits the compact line when there are no plugin health problems", () => {
    expect(formatCompactPluginHealthLine(emptySnapshot)).toBeUndefined();
  });

  it("summarizes plugin errors and context engine quarantines in the compact line", () => {
    expect(
      formatCompactPluginHealthLine({
        plugins: [
          {
            id: "broken-plugin",
            status: "error",
            enabled: true,
            error: "boom",
          },
        ],
        diagnostics: [],
        contextEngineQuarantines: [
          {
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "replay guard tripped",
            failedAt: new Date(0),
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 plugin error · 1 context engine quarantine");
  });

  it("counts runtime tool quarantines and channel plugin failures as compact problems", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported anyOf",
            failedAt: new Date(0),
          },
        ],
        channelPluginFailures: [
          {
            channelId: "sms",
            pluginId: "sms-plugin",
            message: "setup failed",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 runtime tool quarantine · 1 channel plugin failure");
  });

  it("does not double-count diagnostics classified as channel plugin failures", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        diagnostics: [
          {
            level: "error",
            pluginId: "broken-channel",
            code: "channel-setup-failure",
            message: "failed to load setup entry: boom",
          },
        ],
        channelPluginFailures: [
          {
            channelId: "broken-channel",
            pluginId: "broken-channel",
            message: "failed to load setup entry: boom",
            source: "diagnostic",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 channel plugin failure");
  });

  it("counts channel setup diagnostics when no channel failure record is present", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        diagnostics: [
          {
            level: "error",
            pluginId: "broken-channel",
            code: "channel-setup-failure",
            message: "failed to load setup entry: boom",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 diagnostic error");
  });

  it("keeps compatibility notices out of the compact problem line", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        compatibilityNotices: [
          {
            pluginId: "legacy-plugin",
            severity: "warn",
            code: "hook-only",
            message: "uses a compatibility shim",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("counts implicitly blocked hooks in the compact line but not operator-chosen ones", () => {
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        blockedHooks: [
          {
            pluginId: "openclaw-beads",
            hookName: "before_prompt_build",
            reason: "conversation-access-missing",
            severity: "error",
            message: "was NOT registered",
          },
        ],
      }),
    ).toBe("⚠️ Plugins: 1 blocked hook");

    // A hook the operator deliberately denied is steady state, not a problem.
    expect(
      formatCompactPluginHealthLine({
        ...emptySnapshot,
        blockedHooks: [
          {
            pluginId: "chatty-plugin",
            hookName: "before_prompt_build",
            reason: "prompt-injection-denied",
            severity: "warn",
            message: "blocked by plugins.entries.chatty-plugin.hooks.allowPromptInjection=false",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("lists blocked hooks in detailed health without double-reporting their diagnostic", () => {
    const message =
      'typed hook "before_prompt_build" from non-bundled plugin "openclaw-beads" was NOT registered: ' +
      "set plugins.entries.openclaw-beads.hooks.allowConversationAccess to true";
    const detailed = formatDetailedPluginHealth({
      ...emptySnapshot,
      diagnostics: [
        {
          level: "error",
          pluginId: "openclaw-beads",
          code: "hook-registration-blocked",
          message,
        },
      ],
      blockedHooks: [
        {
          pluginId: "openclaw-beads",
          hookName: "before_prompt_build",
          reason: "conversation-access-missing",
          severity: "error",
          message,
        },
      ],
    });

    expect(detailed).toContain("Blocked plugin hooks: 1");
    expect(detailed).toContain(
      `- ERROR openclaw-beads before_prompt_build [conversation-access-missing]: ${message}`,
    );
    // The diagnostic is the same fact; it must not also appear in Diagnostics.
    expect(detailed).not.toContain("Diagnostics:");
    expect(detailed).toContain("⚠️ Plugins: 1 blocked hook");
  });

  it("still reports a hook-blocked diagnostic that has no matching blocked-hook record", () => {
    const detailed = formatDetailedPluginHealth({
      ...emptySnapshot,
      diagnostics: [
        {
          level: "error",
          pluginId: "ghost-plugin",
          code: "hook-registration-blocked",
          message: "orphaned blocked-hook diagnostic",
        },
      ],
    });

    expect(detailed).toContain("Diagnostics: 1 errors · 0 warnings");
    expect(detailed).toContain("- ERROR ghost-plugin: orphaned blocked-hook diagnostic");
    expect(detailed).not.toContain("Blocked plugin hooks:");
  });

  it("caps the blocked hook list and reports the overflow", () => {
    const detailed = formatDetailedPluginHealth({
      ...emptySnapshot,
      blockedHooks: Array.from({ length: 10 }, (_unused, index) => ({
        pluginId: `plugin-${index}`,
        hookName: "agent_end",
        reason: "conversation-access-missing",
        severity: "error" as const,
        message: `blocked ${index}`,
      })),
    });

    expect(detailed).toContain("Blocked plugin hooks: 10");
    expect(detailed).toContain("- +2 more blocked hooks");
  });

  it("merges runtime health into installed plugin snapshots for detailed status", () => {
    const snapshot = mergeStatusPluginHealthSnapshots(
      {
        plugins: [{ id: "installed-ok", status: "loaded", enabled: true }],
        diagnostics: [],
        contextEngineQuarantines: [],
        compatibilityNotices: [
          {
            pluginId: "compat-only",
            severity: "warn",
            code: "hook-only",
            message: "is hook-only",
          },
        ],
      },
      {
        plugins: [
          {
            id: "runtime-broken",
            status: "error",
            enabled: true,
            failurePhase: "load",
            error: "runtime load failed",
          },
        ],
        diagnostics: [
          {
            level: "error",
            pluginId: "runtime-broken",
            code: "channel-setup-failure",
            message: "failed to load setup entry: runtime load failed",
          },
        ],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [
          {
            toolName: "bad_tool",
            owner: "plugin:bad-tools",
            reason: "unsupported schema",
            failedAt: new Date(789),
          },
        ],
        channelPluginFailures: [
          {
            channelId: "runtime-broken",
            pluginId: "runtime-broken",
            message: "failed to load setup entry: runtime load failed",
            source: "diagnostic",
          },
        ],
        blockedHooks: [
          {
            pluginId: "openclaw-beads",
            hookName: "before_prompt_build",
            reason: "conversation-access-missing",
            severity: "error",
            message: "was NOT registered",
          },
        ],
      },
    );

    expect(snapshot.plugins).toContainEqual({
      id: "runtime-broken",
      status: "error",
      enabled: true,
      failurePhase: "load",
      error: "runtime load failed",
    });
    expect(snapshot.runtimeToolQuarantines).toHaveLength(1);
    expect(snapshot.channelPluginFailures).toContainEqual({
      channelId: "runtime-broken",
      pluginId: "runtime-broken",
      message: "failed to load setup entry: runtime load failed",
      source: "diagnostic",
    });
    expect(snapshot.compatibilityNotices).toContainEqual({
      pluginId: "compat-only",
      severity: "warn",
      code: "hook-only",
      message: "is hook-only",
    });
    // Runtime-only fact: the installed disk scan never attempts registration.
    expect(snapshot.blockedHooks).toStrictEqual([
      {
        pluginId: "openclaw-beads",
        hookName: "before_prompt_build",
        reason: "conversation-access-missing",
        severity: "error",
        message: "was NOT registered",
      },
    ]);
  });

  it("keeps repeat registrations of one hook distinct through the merge", () => {
    // A plugin may call api.on() for the same hook several times (distinct
    // registrationId, priority or trigger eligibility). When the policy refuses
    // them, every one of those handlers is dead, so plugin+hook+reason is not a
    // unique key. Deduping on it made the merged detailed view under-count them
    // while compact status read the raw runtime records and counted them all.
    const message = 'typed hook "before_agent_reply" was NOT registered';
    const blocked = {
      pluginId: "repeat-hooks",
      hookName: "before_agent_reply",
      reason: "conversation-access-missing",
      severity: "error",
      message,
    } as const;
    const runtime: StatusPluginHealthSnapshot = {
      ...emptySnapshot,
      blockedHooks: [blocked, blocked],
    };

    const merged = mergeStatusPluginHealthSnapshots(emptySnapshot, runtime);

    expect(merged.blockedHooks).toStrictEqual([blocked, blocked]);
    // The two surfaces must report the same number of dead handlers.
    expect(formatCompactPluginHealthLine(merged)).toBe("⚠️ Plugins: 2 blocked hooks");
    expect(formatCompactPluginHealthLine(runtime)).toBe(formatCompactPluginHealthLine(merged));
    expect(formatDetailedPluginHealth(merged)).toContain("Blocked plugin hooks: 2");
  });

  it("does not double-count a single blocked hook through the merge", () => {
    // The merge concatenates both sides; the installed disk scan never attempts
    // registration, so a lone runtime refusal must stay exactly one row.
    const merged = mergeStatusPluginHealthSnapshots(emptySnapshot, {
      ...emptySnapshot,
      blockedHooks: [
        {
          pluginId: "single-hook",
          hookName: "before_agent_reply",
          reason: "conversation-access-missing",
          severity: "error",
          message: "was NOT registered",
        },
      ],
    });

    expect(merged.blockedHooks).toHaveLength(1);
    expect(formatCompactPluginHealthLine(merged)).toBe("⚠️ Plugins: 1 blocked hook");
    expect(formatDetailedPluginHealth(merged)).toContain("Blocked plugin hooks: 1");
  });

  it("includes detailed plugin state without dumping the full plugin registry", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "ok-plugin", status: "loaded", enabled: true },
        { id: "disabled-plugin", status: "disabled", enabled: false },
        {
          id: "bad-plugin",
          status: "error",
          enabled: true,
          failurePhase: "load",
          error: "module failed",
        },
      ],
      diagnostics: [{ level: "warn", pluginId: "bad-plugin", message: "deprecated hook" }],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(0),
        },
      ],
      channelPluginFailures: [
        {
          channelId: "sms",
          pluginId: "sms-plugin",
          message: "setup failed",
          source: "setup",
        },
      ],
      compatibilityNotices: [
        {
          pluginId: "legacy-plugin",
          severity: "warn",
          code: "hook-only",
          message: "uses a compatibility shim",
        },
      ],
    });

    expect(text).toContain(
      "⚠️ Plugins: 1 plugin error · 1 runtime tool quarantine · 1 channel plugin failure",
    );
    expect(text).toContain("Loaded: 1 (ok-plugin)");
    expect(text).toContain("Disabled: 1");
    expect(text).toContain("- disabled: 1 (disabled-plugin)");
    expect(text).toContain("- bad-plugin [load]: module failed");
    expect(text).toContain("- bad_tool owner=plugin:bad-tools: unsupported anyOf");
    expect(text).toContain("- sms plugin=sms-plugin [setup]: setup failed");
    expect(text).toContain("Diagnostics: 0 errors · 1 warnings");
    expect(text).toContain("- WARN legacy-plugin [hook-only]: uses a compatibility shim");
    expect(text).toContain("Full inventory: /plugins list");
  });

  it("groups disabled plugins by their recorded disable reason", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "zeta", status: "disabled", enabled: false, error: "not in allowlist" },
        {
          id: "alpha",
          status: "disabled",
          enabled: false,
          error: "overridden by better-alpha plugin",
        },
        { id: "beta", status: "disabled", enabled: false, error: "not in allowlist" },
        // No recorded reason (hand-built snapshot): falls back to a plain "disabled".
        { id: "mid", status: "disabled", enabled: false },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
    });

    const lines = text.split("\n");
    const disabledAt = lines.indexOf("Disabled: 4");
    expect(disabledAt).toBeGreaterThan(-1);
    // One line per distinct reason, right under the count, in deterministic
    // reason order with alphabetical plugin ids.
    expect(lines.slice(disabledAt + 1, disabledAt + 4)).toEqual([
      "- disabled: 1 (mid)",
      "- not in allowlist: 2 (beta, zeta)",
      "- overridden by better-alpha plugin: 1 (alpha)",
    ]);
  });

  it("caps disabled reason lines and per-reason id lists", () => {
    const distinctReasons = formatDetailedPluginHealth({
      plugins: Array.from({ length: 9 }, (_, index) => ({
        id: `plugin-${index}`,
        status: "disabled" as const,
        enabled: false,
        error: `reason ${index}`,
      })),
      diagnostics: [],
      contextEngineQuarantines: [],
    });
    expect(distinctReasons).toContain("Disabled: 9");
    expect(distinctReasons).toContain("- reason 7: 1 (plugin-7)");
    expect(distinctReasons).not.toContain("reason 8");
    expect(distinctReasons).toContain("- +1 more reasons");

    const sharedReason = formatDetailedPluginHealth({
      plugins: Array.from({ length: 10 }, (_, index) => ({
        id: `plugin-${index}`,
        status: "disabled" as const,
        enabled: false,
        error: "not in allowlist",
      })),
      diagnostics: [],
      contextEngineQuarantines: [],
    });
    expect(sharedReason).toContain("Disabled: 10");
    expect(sharedReason).toContain(
      "- not in allowlist: 10 (plugin-0, plugin-1, plugin-2, plugin-3, plugin-4, plugin-5, plugin-6, plugin-7, +2 more)",
    );
  });

  it("separates runtime-loaded plugins from installed-but-not-active inventory", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "runtime-ok", status: "loaded", enabled: true },
        // Disk scan marks this "loaded" from config, but the runtime registry
        // never loaded it (absent from runtimeLoadedPluginIds).
        { id: "installed-idle", status: "loaded", enabled: true },
        { id: "broken", status: "error", enabled: true, failurePhase: "load", error: "boom" },
        { id: "off", status: "disabled", enabled: false },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
    });

    expect(text).toContain("Loaded: 1 (runtime-ok)");
    expect(text).toContain("Installed (not active): 1 (installed-idle)");
    expect(text).toContain("Disabled: 1");
    // The errored plugin stays in Errors and the disabled plugin in Disabled;
    // neither leaks into the installed inventory line.
    expect(text).toContain("- broken [load]: boom");
    expect(text).not.toContain("Loaded: 2");
  });

  it("falls back to status-loaded when runtime provenance is absent", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "a", status: "loaded", enabled: true },
        { id: "b", status: "loaded", enabled: true },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
    });

    expect(text).toContain("Loaded: 2 (a, b)");
    expect(text).not.toContain("Installed (not active):");
  });

  it("keeps installed-only loaded plugins out of Loaded after merge", () => {
    const snapshot = mergeStatusPluginHealthSnapshots(
      {
        plugins: [{ id: "installed-idle", status: "loaded", enabled: true }],
        diagnostics: [],
        contextEngineQuarantines: [],
      },
      {
        plugins: [{ id: "runtime-ok", status: "loaded", enabled: true }],
        diagnostics: [],
        contextEngineQuarantines: [],
        runtimeLoadedPluginIds: ["runtime-ok"],
      },
    );

    expect(snapshot.runtimeLoadedPluginIds).toEqual(["runtime-ok"]);
    const text = formatDetailedPluginHealth(snapshot);
    expect(text).toContain("Loaded: 1 (runtime-ok)");
    expect(text).toContain("Installed (not active): 1 (installed-idle)");
  });

  it("lists runtime-loaded plugins even when absent from the merged plugin records", () => {
    // A plugin live only via a pinned runtime surface is in runtimeLoadedPluginIds
    // but not in snapshot.plugins; it must still show under Loaded, not be dropped.
    const text = formatDetailedPluginHealth({
      plugins: [{ id: "active-ok", status: "loaded", enabled: true }],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["active-ok", "pinned-only"],
    });

    expect(text).toContain("Loaded: 2 (active-ok, pinned-only)");
    expect(text).not.toContain("Installed (not active):");
  });

  it("flags should-run plugins missing from the runtime-loaded set as drift", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "runtime-ok", status: "loaded", enabled: true },
        // Planned for eager startup but never loaded at runtime: drift.
        { id: "planned-missing", status: "loaded", enabled: true },
        // Installed/discovered but not in the startup plan: neutral inventory.
        { id: "not-planned-idle", status: "loaded", enabled: true },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
      shouldRunPluginIds: ["planned-missing", "runtime-ok"],
    });

    expect(text).toContain("Loaded: 1 (runtime-ok)");
    expect(text).toContain("Configured to run but not loaded: 1 (planned-missing)");
    // Not-planned stays neutral; the drift id never appears in both inventory lines.
    expect(text).toContain("Installed (not active): 1 (not-planned-idle)");
  });

  it("reports no drift when every should-run plugin is runtime-loaded", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "a", status: "loaded", enabled: true },
        { id: "b", status: "loaded", enabled: true },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["a", "b"],
      shouldRunPluginIds: ["a", "b"],
    });

    expect(text).toContain("Loaded: 2 (a, b)");
    expect(text).not.toContain("Configured to run but not loaded:");
  });

  it("does not re-report should-run plugins already shown as error or disabled", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "runtime-ok", status: "loaded", enabled: true },
        { id: "broken", status: "error", enabled: true, failurePhase: "load", error: "boom" },
        { id: "off", status: "disabled", enabled: false },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
      // Both broken and off are in the startup plan but already explained by their
      // own records, so neither should surface as drift.
      shouldRunPluginIds: ["broken", "off", "runtime-ok"],
    });

    expect(text).toContain("- broken [load]: boom");
    expect(text).toContain("Disabled: 1");
    expect(text).not.toContain("Configured to run but not loaded:");
  });

  it("omits the drift line when the should-run set is absent (back-compat)", () => {
    const text = formatDetailedPluginHealth({
      plugins: [
        { id: "runtime-ok", status: "loaded", enabled: true },
        { id: "installed-idle", status: "loaded", enabled: true },
      ],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
    });

    expect(text).toContain("Installed (not active): 1 (installed-idle)");
    expect(text).not.toContain("Configured to run but not loaded:");
  });

  it("flags configured memory embedding providers that no loaded plugin registers", () => {
    const text = formatDetailedPluginHealth({
      plugins: [{ id: "runtime-ok", status: "loaded", enabled: true }],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
      unregisteredMemoryEmbeddingProviders: [
        { configuredId: "custom-embed", source: "provider" },
        { configuredId: "fallback-embed", source: "fallback" },
      ],
    });

    expect(text).toContain(
      "Configured memory provider not registered: 2 (custom-embed (memorySearch.provider), fallback-embed (memorySearch.fallback))",
    );
    // Observer-only: the unregistered-provider signal never enters the compact line.
    expect(text.split("\n")[0]).toBe("🔌 Plugins: OK");
  });

  it("omits the memory-provider line when none are unregistered or the field is absent", () => {
    const withEmpty = formatDetailedPluginHealth({
      plugins: [{ id: "runtime-ok", status: "loaded", enabled: true }],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
      unregisteredMemoryEmbeddingProviders: [],
    });
    const withAbsent = formatDetailedPluginHealth({
      plugins: [{ id: "runtime-ok", status: "loaded", enabled: true }],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeLoadedPluginIds: ["runtime-ok"],
    });

    expect(withEmpty).not.toContain("Configured memory provider not registered:");
    expect(withAbsent).not.toContain("Configured memory provider not registered:");
  });
});
