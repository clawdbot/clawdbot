/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage, configSelectionFromSearch, type ConfigPageId } from "./config-page.ts";
import type { ConfigRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(async () => {
  const mounted = document.querySelectorAll<ConfigPage>("openclaw-config-page");
  document.body.replaceChildren();
  await settleLitElements(mounted);
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("configSelectionFromSearch", () => {
  it("opens a valid linked Settings section", () => {
    expect(configSelectionFromSearch("communications", "?section=tts")).toEqual({
      activeSection: "tts",
      activeSubsection: null,
    });
  });

  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });

  it("keeps MCP separate from Infrastructure", () => {
    expect(configSelectionFromSearch("mcp", "?section=browser")).toEqual({
      activeSection: "mcp",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("infrastructure", "?section=mcp")).toEqual({
      activeSection: "gateway",
      activeSubsection: null,
    });
  });

  it("keeps the Updates section off Advanced", () => {
    expect(configSelectionFromSearch("advanced", "?section=update")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
  });
});

describe("ConfigPage advanced selection guard", () => {
  it("keeps curated sections off the Advanced page", () => {
    expect(configSelectionFromSearch("advanced", "?section=messages")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=env")).toEqual({
      activeSection: "env",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=mcp")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=tts")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=broadcast")).toEqual({
      activeSection: "broadcast",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=models")).toEqual({
      activeSection: "models",
      activeSubsection: null,
    });
  });
});

describe("ConfigPage default selections", () => {
  it.each([
    ["communications", "messages"],
    ["appearance", "__appearance__"],
    ["notifications", "__notifications__"],
    ["security", "security"],
    ["automation", "commands"],
    ["mcp", "mcp"],
    ["memory", "memory"],
    ["talk", "talk"],
    ["infrastructure", "gateway"],
    ["updates", "update"],
    ["ai-agents", "agents"],
    ["advanced", null],
  ] as const)("opens %s at its default when no section is selected", (pageId, activeSection) => {
    for (const search of ["", "?section="]) {
      expect(configSelectionFromSearch(pageId, search)).toEqual({
        activeSection,
        activeSubsection: null,
      });
    }
  });

  it.each(["unknown", "toString", "constructor", "__proto__"])(
    "rejects an unsupported runtime page id: %s",
    (pageId) => {
      expect(() => configSelectionFromSearch(pageId as ConfigPageId, "")).toThrow(
        "Unknown config page",
      );
    },
  );

  it("keeps subsequent defaults independent from a mutated selection", () => {
    const selection = configSelectionFromSearch("communications", "");
    selection.activeSection = "tts";
    selection.activeSubsection = "provider";

    expect(configSelectionFromSearch("communications", "")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });
});

function routeContext(): ApplicationContext {
  const config = { messages: { ackReaction: "!" }, tts: { provider: "synthetic" } };
  const subscribe = () => () => undefined;
  const { gateway } = createApplicationGateway({
    client: null,
    phase: "offline",
    offlineStable: true,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  return {
    basePath: "",
    gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "test" },
      subscribe,
    },
    runtimeConfig: {
      state: {
        connected: false,
        configLoading: false,
        configSchemaLoading: false,
        configSnapshot: { config, runtimeConfig: config, hash: "settings-defaults" },
        configSchema: {
          type: "object",
          properties: {
            messages: { type: "object", properties: { ackReaction: { type: "string" } } },
            tts: { type: "object", properties: { provider: { type: "string" } } },
          },
        },
        configUiHints: {},
        configForm: config,
        configFormOriginal: config,
        configRaw: JSON.stringify(config),
        configRawOriginal: JSON.stringify(config),
        configValid: true,
        configIssues: [],
      },
      ensureLoaded: async () => undefined,
      ensureSchemaLoaded: async () => undefined,
      subscribe,
    },
    theme: { serverSelection: null, subscribe },
    overlays: { snapshot: {}, subscribe },
    webPush: { snapshot: undefined, subscribe },
  } as unknown as ApplicationContext;
}

describe("ConfigPage route selections", () => {
  it.each([
    ["communications", "", "config-section-messages", "config-section-tts"],
    ["communications", "?section=tts", "config-section-tts", "config-section-messages"],
    ["notifications", "", "settings-communications-notifications", "config-section-messages"],
  ] as const)(
    "renders the selected section for %s%s",
    async (pageId, search, visibleId, absentId) => {
      const route = expectDefined(
        pages.find((entry) => entry.id === pageId),
        "config route",
      );
      const context = routeContext();
      const location = { pathname: `/settings/${pageId}`, search, hash: "" };
      const data = await route.loader?.(context, {
        location,
        signal: new AbortController().signal,
        shouldRun: () => true,
        revalidating: false,
        deps: expectDefined(route.loaderDeps, "config route dependencies")(context, location),
        cause: "navigation",
      });
      if (!data || typeof data !== "object" || !("section" in data)) {
        throw new Error("Config route did not return section data");
      }
      const module = await route.component();
      const provider = createApplicationContextProvider(context);
      document.body.append(provider);
      render(module.render(data as ConfigRouteData), provider);
      const page = expectDefined(
        provider.querySelector<ConfigPage>("openclaw-config-page"),
        "mounted config page",
      );
      await settleLitElement(page);

      expect(page.querySelector(`#${visibleId}`)).not.toBeNull();
      expect(page.querySelector(`#${absentId}`)).toBeNull();
      if (pageId === "communications") {
        expect(page.querySelector('wa-tab[aria-selected="true"]')?.textContent?.trim()).toBe(
          search ? "Voice" : "Messages",
        );
      }
    },
  );
});
