/** Covers which plugin owns a channel's surfaced config schema when several claim the same id. */
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";

type ClaimantParams = {
  id: string;
  origin?: string;
  preferOver?: readonly string[];
  catalogPreferOver?: readonly string[];
};

function claimant({ id, origin = "global", preferOver, catalogPreferOver }: ClaimantParams) {
  return {
    id,
    origin,
    channels: ["clickclack"],
    ...(catalogPreferOver
      ? { channelCatalogMeta: { id: "clickclack", preferOver: catalogPreferOver } }
      : {}),
    channelConfigs: {
      clickclack: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { [`${id}Token`]: { type: "string" } },
        },
        ...(preferOver ? { preferOver } : {}),
      },
    },
  };
}

function ownerOf(plugins: ReturnType<typeof claimant>[]): string | undefined {
  const registry = { plugins, diagnostics: [] } as unknown as PluginManifestRegistry;
  return collectChannelSchemaMetadataWithOwnership(registry).find(
    (entry) => entry.id === "clickclack",
  )?.schemaPluginId;
}

describe("collectChannelSchemaMetadataWithOwnership", () => {
  // #92884: auto-enable skips a candidate that another configured plugin lists in `preferOver`,
  // but schema selection ranked only by origin. Two same-origin claimants therefore resolved by
  // iteration order, so `config validate` could reject the config keys of the very plugin the
  // runtime activates. Ownership has to follow the declaration in both orders.
  it.each([
    { order: "replacement last", plugins: ["clickclack-core", "clickclack-plus"] },
    { order: "replacement first", plugins: ["clickclack-plus", "clickclack-core"] },
  ])("gives a same-origin replacement the schema when it is listed $order", ({ plugins }) => {
    const byId = {
      "clickclack-core": claimant({ id: "clickclack-core" }),
      "clickclack-plus": claimant({
        id: "clickclack-plus",
        preferOver: ["clickclack-core"],
      }),
    };

    expect(ownerOf(plugins.map((id) => byId[id as keyof typeof byId]))).toBe("clickclack-plus");
  });

  it("reads a replacement declared through channelCatalogMeta", () => {
    const core = claimant({ id: "clickclack-core" });
    const replacement = claimant({
      id: "clickclack-plus",
      catalogPreferOver: ["clickclack-core"],
    });

    expect(ownerOf([replacement, core])).toBe("clickclack-plus");
  });

  it("keeps a closer origin ahead of a farther plugin that claims to replace it", () => {
    const workspace = claimant({ id: "clickclack-core", origin: "workspace" });
    const bundled = claimant({
      id: "clickclack-plus",
      origin: "bundled",
      preferOver: ["clickclack-core"],
    });

    // Origin rank still decides across origins; `preferOver` only settles same-origin ties.
    expect(ownerOf([workspace, bundled])).toBe("clickclack-core");
  });

  it("leaves undeclared same-origin claimants on the existing last-writer behavior", () => {
    const first = claimant({ id: "clickclack-core" });
    const second = claimant({ id: "clickclack-plus" });

    expect(ownerOf([first, second])).toBe("clickclack-plus");
    expect(ownerOf([second, first])).toBe("clickclack-core");
  });
});
