import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
} from "./command-palette-catalog-search.ts";

describe("command palette catalog search", () => {
  it("reports failed acquisition from a successful catalog read while keeping its rows", async () => {
    const result = await loadCommandPaletteCatalogItems({
      client: createTestGatewayClient(async () => ({
        models: [{ provider: "ollama", id: "retained", name: "Retained model", available: true }],
        providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
      })),
      agentId: "main",
      agents: async () => null,
      methodAvailable: (method) => method === "models.list",
    });

    expect(result.items).toContainEqual(
      expect.objectContaining({ category: "models", label: "Retained model" }),
    );
    expect(result.modelSearchError).toBe(
      "Some models could not be refreshed. Open Models to try again.",
    );
    expect(result.modelRequestFailed).toBe(false);
  });

  it("opens meeting transcripts from search without querying agent chat history", () => {
    const items = filterCommandPaletteItems({
      query: "meeting",
      includeSlashCommands: false,
      sessionItems: [],
      catalogItems: [],
      desktopAvailable: false,
      custodianAvailable: false,
    });
    expect(items).toContainEqual(
      expect.objectContaining({ label: "Meetings", action: "nav:meetings" }),
    );
  });
  it("exposes app cards and permission-filtered settings sections without RPCs", () => {
    const regular = getStaticCommandPaletteCatalogItems(false);
    const admin = getStaticCommandPaletteCatalogItems(true);

    expect(regular).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "apps", label: "iPhone" }),
        expect.objectContaining({ category: "settings", routeId: "profile" }),
      ]),
    );
    expect(regular.some((item) => item.routeId === "security")).toBe(false);
    expect(admin.some((item) => item.routeId === "security")).toBe(true);
    expect(regular.some((item) => item.label === "Meeting capture")).toBe(false);
    expect(admin).toContainEqual(
      expect.objectContaining({
        label: "Meeting capture",
        routeId: "communications",
        search: "?section=transcripts",
      }),
    );
  });

  it("loads bounded name and description catalogs in parallel", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "cron.list":
          return {
            jobs: [
              {
                id: "nightly",
                name: "Nightly invoices",
                description: "Reconciles customer billing",
              },
            ],
          };
        case "skills.status":
          return {
            skills: [
              {
                skillKey: "forecast-brief",
                name: "Forecast brief",
                description: "Summarizes the weather",
                source: "workspace",
              },
            ],
          };
        case "plugins.list":
          return {
            plugins: [
              {
                id: "weather-helper",
                name: "Weather helper",
                description: "Adds forecast tools",
                packageName: "@openclaw/weather-helper",
              },
            ],
          };
        case "models.list":
          return {
            models: [
              {
                id: "gpt-search",
                name: "Search model",
                provider: "openai",
                tags: ["fast"],
              },
            ],
          };
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    });

    const { items } = await loadCommandPaletteCatalogItems({
      client: { request } as unknown as GatewayBrowserClient,
      agentId: "main",
      agents: async () => ({
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main", name: "Main assistant", workspace: "/workspace" }],
      }),
      methodAvailable: () => true,
    });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "agents", label: "Main assistant" }),
        expect.objectContaining({ category: "automations", label: "Nightly invoices" }),
        expect.objectContaining({ category: "skills", label: "Forecast brief" }),
        expect.objectContaining({ category: "plugins", label: "Weather helper" }),
        expect.objectContaining({ category: "models", label: "Search model" }),
      ]),
    );
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ includeDisabled: true, limit: 200, offset: 0, compact: true }),
    );
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("plugins.list", {});
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
      preparedOnly: true,
    });
  });
});
