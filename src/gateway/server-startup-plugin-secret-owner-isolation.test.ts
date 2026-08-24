/** Real Gateway coverage for manifest-owned plugin SecretRef identity and refresh isolation. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { runtimePluginManifestSecretOwnerId } from "../secrets/runtime-plugin-manifest-secret-owner.js";
import {
  getActiveSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("Gateway startup manifest-owned plugin secret isolation", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  const pluginRoots: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const root of pluginRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates all plugin owner domains and concrete paths across provider auth refresh", async () => {
    const coldPluginId = "skill.config.auth-profiles.probe";
    const healthyPluginId = "skill";
    const pluginIds = [coldPluginId, healthyPluginId] as const;
    const roots = pluginIds.map((pluginId) => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), `openclaw-secret-owner-${pluginId}-`),
      );
      pluginRoots.push(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: pluginId,
          version: "1.0.0",
          type: "commonjs",
          main: "./index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: { type: "object", additionalProperties: true },
          configContracts: {
            secretInputs: {
              paths: [
                { path: "capabilityToken", ownerKind: "capability", ownerId: "shared-owner" },
                { path: "providerToken", ownerKind: "provider", ownerId: "shared-owner" },
                {
                  path:
                    pluginId === coldPluginId
                      ? "routeToken"
                      : "auth-profiles.probe.config.routeToken",
                  ownerKind: "route",
                },
                { path: "headers.*", ownerKind: "route" },
                { path: "headers.X.Trace", ownerKind: "route" },
              ],
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
        "utf8",
      );
      return root;
    });

    await withEnvAsync(
      {
        COLD_PLUGIN_CAPABILITY_TOKEN: undefined,
        COLD_PLUGIN_PROVIDER_TOKEN: undefined,
        COLD_PLUGIN_ROUTE_TOKEN: undefined,
        COLD_PLUGIN_DOTTED_HEADER_TOKEN: undefined,
        COLD_PLUGIN_NESTED_HEADER_TOKEN: undefined,
        HEALTHY_PLUGIN_CAPABILITY_TOKEN: "healthy-capability-secret",
        HEALTHY_PLUGIN_PROVIDER_TOKEN: "healthy-provider-secret",
        HEALTHY_PLUGIN_ROUTE_TOKEN: "healthy-route-secret",
        HEALTHY_PLUGIN_DOTTED_HEADER_TOKEN: "healthy-dotted-header-secret",
        HEALTHY_PLUGIN_NESTED_HEADER_TOKEN: "healthy-nested-header-secret",
        HEALTHY_CORE_CAPABILITY_TOKEN: "healthy-core-capability-secret",
        HEALTHY_CORE_PROVIDER_TOKEN: "healthy-core-provider-secret",
      },
      async () => {
        const coldRouteRef = envRef("COLD_PLUGIN_ROUTE_TOKEN");
        const coldDottedHeaderRef = envRef("COLD_PLUGIN_DOTTED_HEADER_TOKEN");
        const coldNestedHeaderRef = envRef("COLD_PLUGIN_NESTED_HEADER_TOKEN");
        const plugins = {
          enabled: true,
          load: { paths: roots },
          allow: [...pluginIds],
          entries: {
            [coldPluginId]: {
              enabled: true,
              config: {
                capabilityToken: envRef("COLD_PLUGIN_CAPABILITY_TOKEN"),
                providerToken: envRef("COLD_PLUGIN_PROVIDER_TOKEN"),
                routeToken: coldRouteRef,
                headers: {
                  "X.Trace": coldDottedHeaderRef,
                  X: { Trace: coldNestedHeaderRef },
                },
              },
            },
            [healthyPluginId]: {
              enabled: true,
              config: {
                capabilityToken: envRef("HEALTHY_PLUGIN_CAPABILITY_TOKEN"),
                providerToken: envRef("HEALTHY_PLUGIN_PROVIDER_TOKEN"),
                "auth-profiles": {
                  probe: { config: { routeToken: envRef("HEALTHY_PLUGIN_ROUTE_TOKEN") } },
                },
                headers: {
                  "X.Trace": envRef("HEALTHY_PLUGIN_DOTTED_HEADER_TOKEN"),
                  X: { Trace: envRef("HEALTHY_PLUGIN_NESTED_HEADER_TOKEN") },
                },
              },
            },
          },
        };
        const { loadOpenClawPlugins } =
          await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
        const registry = loadOpenClawPlugins({
          cache: false,
          config: { plugins },
          onlyPluginIds: [...pluginIds],
        });
        expect(registry.plugins.map(({ id, status }) => ({ id, status }))).toEqual([
          { id: coldPluginId, status: "loaded" },
          { id: healthyPluginId, status: "loaded" },
        ]);
        setTestPluginRegistry(registry);
        const { writeConfigFile } = await import("../config/config.js");
        await writeConfigFile({
          gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
          agents: { entries: { main: { default: true } } },
          secrets: { providers: { default: { source: "env" } } },
          models: {
            providers: {
              "skill:shared-owner": {
                apiKey: envRef("HEALTHY_CORE_PROVIDER_TOKEN"),
                baseUrl: "https://example.invalid/v1",
                models: [],
              },
            },
          },
          skills: {
            entries: {
              "shared-owner": { apiKey: envRef("HEALTHY_CORE_CAPABILITY_TOKEN") },
            },
          },
          plugins,
        });

        const port = await getGatewayTestPort();
        server = await startTestGatewayServer(port, { auth: { mode: "none" } });
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({ ready: true });

        const coldPathPrefix = `plugins.entries[${JSON.stringify(coldPluginId)}].config`;
        const healthyPathPrefix = `plugins.entries.${healthyPluginId}.config`;
        const coldSharedOwnerId = runtimePluginManifestSecretOwnerId(coldPluginId, "shared-owner");
        const healthySharedOwnerId = runtimePluginManifestSecretOwnerId(
          healthyPluginId,
          "shared-owner",
        );
        const coldRelativePaths = ["routeToken", 'headers["X.Trace"]', "headers.X.Trace"];
        const healthyRelativePaths = [
          "auth-profiles.probe.config.routeToken",
          'headers["X.Trace"]',
          "headers.X.Trace",
        ];
        const expectedDegraded = [
          {
            ownerKind: "plugin-capability",
            ownerId: coldSharedOwnerId,
            paths: [`${coldPathPrefix}.capabilityToken`],
          },
          {
            ownerKind: "plugin-provider",
            ownerId: coldSharedOwnerId,
            paths: [`${coldPathPrefix}.providerToken`],
          },
          ...coldRelativePaths.map((relativePath) => ({
            ownerKind: "plugin-route",
            ownerId: runtimePluginManifestSecretOwnerId(coldPluginId, relativePath),
            paths: [`${coldPathPrefix}.${relativePath}`],
          })),
        ];
        const assertIsolatedPluginOwners = () => {
          const snapshot = getActiveSecretsRuntimeSnapshot();
          expect(snapshot?.degradedOwners).toMatchObject(expectedDegraded);
          expect(snapshot?.secretOwners).toEqual(
            expect.arrayContaining([
              ...expectedDegraded.map(({ ownerKind, ownerId }) =>
                expect.objectContaining({ ownerKind, ownerId }),
              ),
              expect.objectContaining({
                ownerKind: "plugin-capability",
                ownerId: healthySharedOwnerId,
              }),
              expect.objectContaining({
                ownerKind: "plugin-provider",
                ownerId: healthySharedOwnerId,
              }),
              ...healthyRelativePaths.map((relativePath) =>
                expect.objectContaining({
                  ownerKind: "plugin-route",
                  ownerId: runtimePluginManifestSecretOwnerId(healthyPluginId, relativePath),
                }),
              ),
              expect.objectContaining({
                ownerKind: "capability",
                ownerId: healthySharedOwnerId,
              }),
              expect.objectContaining({
                ownerKind: "provider",
                ownerId: healthySharedOwnerId,
              }),
            ]),
          );
          expect(snapshot?.warnings).toEqual(
            expect.arrayContaining(
              expectedDegraded.map(({ paths }) =>
                expect.objectContaining({
                  code: "SECRETS_OWNER_UNAVAILABLE",
                  path: paths[0],
                }),
              ),
            ),
          );
          expect(snapshot?.config.plugins?.entries?.[coldPluginId]?.config).toMatchObject({
            routeToken: coldRouteRef,
            headers: { "X.Trace": coldDottedHeaderRef, X: { Trace: coldNestedHeaderRef } },
          });
          expect(snapshot?.config.plugins?.entries?.[healthyPluginId]?.config).toEqual({
            capabilityToken: "healthy-capability-secret",
            providerToken: "healthy-provider-secret",
            "auth-profiles": { probe: { config: { routeToken: "healthy-route-secret" } } },
            headers: {
              "X.Trace": "healthy-dotted-header-secret",
              X: { Trace: "healthy-nested-header-secret" },
            },
          });
          expect(snapshot?.config.models?.providers?.[healthySharedOwnerId]?.apiKey).toBe(
            "healthy-core-provider-secret",
          );
          expect(snapshot?.config.skills?.entries?.["shared-owner"]?.apiKey).toBe(
            "healthy-core-capability-secret",
          );
          for (const ownerKind of ["plugin-capability", "plugin-provider"] as const) {
            expect(() => assertSecretOwnerAvailable(ownerKind, coldSharedOwnerId)).toThrow(
              "configured but unavailable",
            );
            expect(() => assertSecretOwnerAvailable(ownerKind, healthySharedOwnerId)).not.toThrow();
          }
          for (const relativePath of coldRelativePaths) {
            const routeOwnerId = runtimePluginManifestSecretOwnerId(coldPluginId, relativePath);
            expect(() => assertSecretOwnerAvailable("plugin-route", routeOwnerId)).toThrow(
              "configured but unavailable",
            );
            expect(() => assertSecretOwnerAvailable("route", routeOwnerId)).not.toThrow();
          }
          for (const relativePath of healthyRelativePaths) {
            expect(() =>
              assertSecretOwnerAvailable(
                "plugin-route",
                runtimePluginManifestSecretOwnerId(healthyPluginId, relativePath),
              ),
            ).not.toThrow();
          }
          expect(() =>
            assertSecretOwnerAvailable("capability", healthySharedOwnerId),
          ).not.toThrow();
          expect(() => assertSecretOwnerAvailable("provider", healthySharedOwnerId)).not.toThrow();
          expect(
            snapshot?.warnings.some(
              ({ path: warningPath }) =>
                warningPath === `${healthyPathPrefix}.headers.X.Trace` ||
                warningPath === `${healthyPathPrefix}.headers["X.Trace"]`,
            ),
          ).toBe(false);
        };

        assertIsolatedPluginOwners();
        await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
        assertIsolatedPluginOwners();
      },
    );
  });
});
