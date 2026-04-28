import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getPluginCompatRecord,
  isPluginCompatCode,
  listDeprecatedPluginCompatRecords,
  listPluginCompatRecords,
} from "./registry.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

const knownDeprecatedSurfaceMarkers = [
  {
    code: "legacy-extension-api-import",
    file: "src/extensionAPI.ts",
    marker: "openclaw/extension-api is deprecated",
  },
  {
    code: "memory-split-registration",
    file: "src/plugins/memory-state.ts",
    marker: "registerMemoryPromptSection",
  },
  {
    code: "provider-static-capabilities-bag",
    file: "src/plugins/types.ts",
    marker: "Legacy static provider capability bag",
  },
  {
    code: "provider-discovery-type-aliases",
    file: "src/plugins/types.ts",
    marker: "ProviderPluginDiscovery = ProviderPluginCatalog",
  },
  {
    code: "provider-thinking-policy-hooks",
    file: "src/plugins/types.ts",
    marker: "Prefer `resolveThinkingProfile`",
  },
  {
    code: "provider-external-oauth-profiles-hook",
    file: "src/plugins/types.ts",
    marker: "resolveExternalOAuthProfiles",
  },
  {
    code: "agent-tool-result-harness-alias",
    file: "src/plugins/agent-tool-result-middleware-types.ts",
    marker: "AgentToolResultMiddlewareHarness",
  },
  {
    code: "runtime-config-load-write",
    file: "src/plugins/runtime/runtime-config.ts",
    marker: "RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE",
  },
  {
    code: "runtime-taskflow-legacy-alias",
    file: "src/plugins/runtime/types-core.ts",
    marker: "taskFlow",
  },
  {
    code: "runtime-subagent-get-session-alias",
    file: "src/plugins/runtime/types.ts",
    marker: "getSessionMessages",
  },
  {
    code: "runtime-stt-alias",
    file: "src/plugins/runtime/types-core.ts",
    marker: "stt",
  },
  {
    code: "runtime-inbound-envelope-alias",
    file: "src/plugins/runtime/types-channel.ts",
    marker: "formatInboundEnvelope",
  },
  {
    code: "channel-native-message-schema-helpers",
    file: "src/plugin-sdk/channel-actions.ts",
    marker: "createMessageToolButtonsSchema",
  },
  {
    code: "channel-mention-gating-legacy-helpers",
    file: "src/plugin-sdk/channel-inbound.ts",
    marker: "resolveMentionGatingWithBypass",
  },
  {
    code: "provider-web-search-core-wrapper",
    file: "src/plugin-sdk/provider-web-search.ts",
    marker: "createPluginBackedWebSearchProvider",
  },
  {
    code: "approval-capability-approvals-alias",
    file: "src/plugin-sdk/approval-delivery-helpers.ts",
    marker: "approvals?: Partial<ChannelApprovalCapabilitySurfaces>",
  },
  {
    code: "plugin-sdk-test-utils-alias",
    file: "src/plugin-sdk/test-utils.ts",
    marker: "focused `openclaw/plugin-sdk/*` test subpaths",
  },
  {
    code: "plugin-install-config-ledger",
    file: "src/config/plugin-install-config-migration.ts",
    marker: "stripShippedPluginInstallConfigRecords",
  },
  {
    code: "bundled-plugin-load-path-aliases",
    file: "src/commands/doctor/shared/bundled-plugin-load-paths.ts",
    marker: "plugins.load.paths",
  },
  {
    code: "plugin-owned-web-search-config",
    file: "src/commands/doctor/shared/legacy-web-search-migrate.ts",
    marker: "tools.web.search",
  },
  {
    code: "plugin-owned-web-fetch-config",
    file: "src/commands/doctor/shared/legacy-web-fetch-migrate.ts",
    marker: "tools.web.fetch.firecrawl",
  },
  {
    code: "plugin-owned-x-search-config",
    file: "src/commands/doctor/shared/legacy-x-search-migrate.ts",
    marker: "tools.web.x_search",
  },
  {
    code: "bundled-channel-config-schema-legacy",
    file: "src/plugin-sdk/channel-config-schema-legacy.ts",
    marker: "Deprecated bundled-channel compatibility surface",
  },
  {
    code: "plugin-sdk-testing-barrel",
    file: "src/plugin-sdk/testing.ts",
    marker: "@deprecated Broad compatibility barrel",
  },
  {
    code: "channel-route-key-aliases",
    file: "src/plugin-sdk/channel-route.ts",
    marker: "channelRouteIdentityKey",
  },
  {
    code: "channel-target-comparable-aliases",
    file: "src/channels/plugins/target-parsing-loaded.ts",
    marker: "ComparableChannelTarget",
  },
] as const;

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addUtcMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

describe("plugin compatibility registry", () => {
  it("keeps compatibility codes unique and lookup-safe", () => {
    const records = listPluginCompatRecords();
    const codes = records.map((record) => record.code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(isPluginCompatCode("legacy-root-sdk-import")).toBe(true);
    expect(isPluginCompatCode("missing-code")).toBe(false);
    expect(getPluginCompatRecord("legacy-root-sdk-import").owner).toBe("sdk");
  });

  it("requires dated deprecation metadata for deprecated records", () => {
    for (const record of listDeprecatedPluginCompatRecords()) {
      expect(record.deprecated, record.code).toMatch(datePattern);
      expect(record.warningStarts, record.code).toMatch(datePattern);
      expect(record.removeAfter, record.code).toMatch(datePattern);
      if (!record.warningStarts || !record.removeAfter) {
        throw new Error(`${record.code} is missing deprecation window dates`);
      }
      const maxRemoveAfter = addUtcMonths(parseDate(record.warningStarts), 3);
      const removeAfter = parseDate(record.removeAfter);
      expect(removeAfter <= maxRemoveAfter, record.code).toBe(true);
      expect(record.replacement, record.code).toBeTruthy();
      expect(record.docsPath, record.code).toMatch(/^\//u);
    }
  });

  it("keeps every record actionable", () => {
    for (const record of listPluginCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.docsPath, record.code).toMatch(/^\//u);
      expect(record.surfaces.length, record.code).toBeGreaterThan(0);
      expect(record.diagnostics.length, record.code).toBeGreaterThan(0);
      expect(record.tests.length, record.code).toBeGreaterThan(0);
      for (const testPath of record.tests) {
        expect(fs.existsSync(testPath), `${record.code}: ${testPath}`).toBe(true);
      }
    }
  });

  it("tracks known plugin-facing deprecated surfaces", () => {
    for (const surface of knownDeprecatedSurfaceMarkers) {
      expect(isPluginCompatCode(surface.code), surface.code).toBe(true);
      expect(fs.readFileSync(surface.file, "utf8"), surface.file).toContain(surface.marker);
    }
  });
});
