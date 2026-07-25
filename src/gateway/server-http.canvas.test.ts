// Core Canvas Gateway route tests cover shipped host-disable switches.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanvasNodeCapability } from "../canvas/constants.js";
import { createCanvasDocument } from "../canvas/documents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  allowTailscale: false,
};
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function requestHostedDocument(params: {
  config: OpenClawConfig;
  skipHost?: string;
}): Promise<Response> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-canvas-gateway-"));
  tempDirs.push(stateDir);
  const document = await createCanvasDocument(
    {
      id: "host-switch-test",
      kind: "html_bundle",
      entrypoint: { type: "html", value: "<html><body>hosted</body></html>" },
    },
    { stateDir },
  );

  return await withEnvAsync(
    {
      OPENCLAW_SKIP_CANVAS_HOST: params.skipHost,
      OPENCLAW_STATE_DIR: stateDir,
    },
    async () => {
      const server = createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        handlePluginRequest: async () => false,
        resolvePluginNodeCapabilityRoute: (pathContext) =>
          resolveCanvasNodeCapability(pathContext.candidates),
        resolvedAuth,
        getRuntimeConfig: () => params.config,
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        return await fetch(`http://127.0.0.1:${port}${document.entryUrl}`, {
          headers: { authorization: "Bearer test-token", connection: "close" },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}

describe("core Canvas Gateway host switches", () => {
  it("serves core widget documents by default", async () => {
    const response = await requestHostedDocument({ config: {} });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hosted");
  });

  it.each([
    {
      label: "plugins.entries.canvas.config.host.enabled=false",
      config: {
        plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
      },
    },
    { label: "OPENCLAW_SKIP_CANVAS_HOST", config: {}, skipHost: "1" },
  ])("does not register the core widget route for $label", async ({ config, skipHost }) => {
    const response = await requestHostedDocument({ config, skipHost });
    expect(response.status).toBe(404);
  });
});
