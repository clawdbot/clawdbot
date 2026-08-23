// Gateway-auth artifact parity contract for bundled channel plugins.
//
// Core resolves unauthenticated Gateway callback paths from lightweight
// `gateway-auth-api` artifacts (src/channels/plugins/gateway-auth-bypass.ts),
// which invoke the export with a `{ cfg }` params object. This suite pins each
// artifact export to the exact function the loaded plugin's gateway surface
// uses and pins the params-object call shape core relies on.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelGatewayAuthArtifactAsync,
  getBundledChannelPluginAsync,
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
  });

  it.each(GATEWAY_AUTH_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s artifact resolver identical to the plugin gateway surface",
    async (id) => {
      const resolveGatewayAuthBypassPaths = artifactResolvers.get(id);
      expect(typeof resolveGatewayAuthBypassPaths).toBe("function");

      const plugin = await getBundledChannelPluginAsync(id);
      expect(plugin?.gateway?.resolveGatewayAuthBypassPaths).toBe(resolveGatewayAuthBypassPaths);
    },
  );

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
