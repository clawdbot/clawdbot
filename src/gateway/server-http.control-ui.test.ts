import fsSync from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("Gateway Control UI identity", () => {
  it.each(["", "/console/"])("keeps UI resource authentication at base %j", async (basePath) => {
    await withGatewayServer({
      prefix: "control-ui-resource-auth",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true, controlUiBasePath: basePath },
      run: async (server) => {
        const base = basePath.replace(/\/$/, "");
        for (const [method, path] of [
          ["GET", `${base}/avatar/main?meta=1`],
          ["GET", `${base}/__openclaw__/assistant-media?source=missing.png`],
          ["POST", `${base}/__openclaw__/assistant-media?meta=1&allow=1&source=missing.png`],
        ] as const) {
          const response = await sendRequest(server, { path, method });
          expect(response.res.statusCode, path).toBe(401);
        }
      },
    });
  });

  it("keeps the root UI POST rejection ahead of the startup fallback", async () => {
    await withGatewayServer({
      prefix: "control-ui-legacy-post",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        isStartupPluginRuntimeReady: () => false,
      },
      run: async (server) => {
        const response = await sendRequest(server, { path: "/ui", method: "POST" });
        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
        expect(response.setHeader).toHaveBeenCalledWith(
          "Permissions-Policy",
          "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
        );
      },
    });
  });

  it.each(["", "/console/"])(
    "leaves unclaimed media writes to startup at base %j",
    async (basePath) => {
      await withGatewayServer({
        prefix: "control-ui-unclaimed-media-write",
        resolvedAuth: AUTH_TOKEN,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: basePath,
          isStartupPluginRuntimeReady: () => false,
        },
        run: async (server) => {
          const base = basePath.replace(/\/$/, "");
          for (const query of ["meta=1", "allow=1", "meta=1&allow=0"]) {
            const response = await sendRequest(server, {
              method: "POST",
              path: `${base}/__openclaw__/assistant-media?${query}&source=missing.png`,
            });
            expect(response.res.statusCode, query).toBe(503);
            expect(response.getBody()).toBe("Plugin runtime is starting");
          }
        },
      });
    },
  );

  it("applies dashboard enablement to subsequent requests without replacing the listener", async () => {
    await withTempDir("openclaw-http-toggle-", async (controlUiRoot) => {
      await fs.writeFile(nodePath.join(controlUiRoot, "index.html"), "<html>synthetic UI</html>\n");
      await fs.mkdir(nodePath.join(controlUiRoot, "assets"));
      await fs.writeFile(nodePath.join(controlUiRoot, "assets", "app.js"), "// synthetic asset\n");
      let enabled: boolean | undefined = false;
      await withGatewayServer({
        prefix: "control-ui-enablement",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: undefined,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getRuntimeConfig: () => ({ gateway: { controlUi: { enabled } } }),
        },
        run: async (server) => {
          for (const next of [false, true, false, undefined]) {
            enabled = next;
            for (const path of ["/", "/chat", "/assets/app.js", "/control-ui-config.json"]) {
              const response = await sendRequest(server, { path, method: "GET" });
              expect(response.res.statusCode, `${path}, enabled=${enabled}`).toBe(
                enabled === false ? 404 : 200,
              );
            }
            const health = await sendRequest(server, { path: "/healthz", method: "GET" });
            expect(health.res.statusCode).toBe(200);
          }
        },
      });
    });
  });

  it("keeps static requests independent of workspace identity reads while bootstrap resolves identity", async () => {
    await withTempDir("openclaw-http-identity-", async (controlUiRoot) => {
      await fs.writeFile(nodePath.join(controlUiRoot, "index.html"), "<html>synthetic UI</html>\n");
      const workspace = await fs.realpath(controlUiRoot);
      await fs.writeFile(
        nodePath.join(controlUiRoot, "IDENTITY.md"),
        "- Name: Synthetic assistant\n",
      );
      await fs.mkdir(nodePath.join(controlUiRoot, "assets"));
      await fs.writeFile(nodePath.join(controlUiRoot, "assets", "app.js"), "// synthetic asset\n");
      await withGatewayServer({
        prefix: "control-ui-static-identity",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getRuntimeConfig: () => ({
            agents: {
              ownership: "explicit",
              entries: { ops: { workspace }, research: {} },
              defaults: { systemAgent: { agentId: "research" } },
            },
          }),
        },
        run: async (server) => {
          const realpath = vi.spyOn(fsSync, "realpathSync");
          const identityReads = () =>
            realpath.mock.calls.filter(
              ([file]) => nodePath.basename(String(file)) === "IDENTITY.md",
            );
          try {
            for (const path of ["/", "/chat", "/assets/app.js"]) {
              const response = await sendRequest(server, { path, method: "GET" });
              expect(response.res.statusCode, path).toBe(200);
            }
            expect(identityReads()).toHaveLength(0);

            const bootstrap = await sendRequest(server, {
              path: "/control-ui-config.json",
              method: "GET",
            });
            expect(JSON.parse(bootstrap.getBody())).toMatchObject({
              assistantAgentId: "ops",
              assistantName: "Synthetic assistant",
              localMediaPreviewRoots: expect.arrayContaining([workspace]),
            });
            expect(identityReads().length).toBeGreaterThan(0);
          } finally {
            realpath.mockRestore();
          }
        },
      });
    });
  });
});
