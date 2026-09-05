// Gateway-auth lightweight artifact contract for bundled channel plugins.
//
// Core resolves unauthenticated Gateway callback paths from lightweight
// `gateway-auth-api` artifacts (src/channels/plugins/gateway-auth-bypass.ts),
// which invoke the export with a `{ cfg }` params object. This shard owns
// inventory, export shape, and that invocation contract; loaded-plugin parity
// lives in plugin-shape.contract.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelGatewayAuthArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level gateway-auth artifact.
const GATEWAY_AUTH_ARTIFACT_PLUGIN_IDS = ["mattermost"] as const;

describe("bundled channel gateway-auth artifact parity", () => {
  const artifactResolvers = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelGatewayAuthArtifactAsync(id);
      if (artifact) {
        artifactResolvers.set(id, artifact.resolveGatewayAuthBypassPaths);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    expect([...artifactResolvers.keys()].toSorted()).toEqual([...GATEWAY_AUTH_ARTIFACT_PLUGIN_IDS]);
    for (const id of GATEWAY_AUTH_ARTIFACT_PLUGIN_IDS) {
      expect(typeof artifactResolvers.get(id)).toBe("function");
    }
  });

  it("resolves mattermost bypass paths through core's { cfg } call shape", () => {
    // Regression pin: the artifact once took `cfg` positionally, so core's
    // `{ cfg }` invocation silently dropped configured callback paths.
    const resolve = artifactResolvers.get("mattermost") as (params: {
      cfg: { channels?: Record<string, unknown> };
    }) => string[];
    const cfg = {
      channels: {
        mattermost: {
          commands: { callbackPath: "/api/channels/mattermost/custom" },
        },
      },
    };

    expect(resolve({ cfg })).toContain("/api/channels/mattermost/custom");
  });
});
