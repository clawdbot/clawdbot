import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRecord } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  listControlUiPluginCatalog,
  listControlUiPluginActivations,
  reportControlUiPluginActivation,
  reloadControlUiPluginCatalog,
} from "./control-ui-plugin-assets.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import {
  listControlUiPluginTabAuthGrants,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  createResponse,
  createTestGatewayServer,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { withTempConfig } from "./test-temp-config.js";

const roots: string[] = [];
const firstSource = 'export default { id: "native-ui" };';

function activateFixture(origin: PluginRecord["origin"] = "bundled") {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-")));
  roots.push(rootDir);
  const directory = path.join(rootDir, "dist/control-ui");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.js"), firstSource);
  fs.writeFileSync(path.join(directory, "theme.css"), "body { color: red; }");
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "native-ui",
    origin,
    rootDir,
    controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] },
  });
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: record.id,
      configSchema: { type: "object", additionalProperties: false },
      controlUi: record.controlUi,
    }),
  );
  registry.plugins.push(record);
  registry.controlUiDescriptors.push({
    pluginId: record.id,
    source: record.source,
    descriptor: { id: "summary", surface: "widget", label: "Native summary" },
  });
  setActivePluginRegistry(registry);
  return { rootDir, directory, registry, record };
}

function cookieForGrant(overrides: { pluginId?: string; generation?: string } = {}): string {
  const response = createResponse();
  const [grant] = listControlUiPluginTabAuthGrants(["operator.read"]);
  if (!grant) {
    throw new Error("Expected scoped Control UI grant");
  }
  setControlUiPluginAuthCookie(
    response.res,
    [{ ...grant, pluginId: overrides.pluginId ?? grant.pluginId }],
    {
      generation: overrides.generation ?? resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
    },
  );
  const value = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  const [cookie] = typeof header === "string" ? header.split(";", 1) : [];
  if (!cookie) {
    throw new Error("Expected scoped Control UI cookie");
  }
  return cookie;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  for (const rootDir of roots.splice(0)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("native Control UI browser assets", () => {
  beforeAll(async () => {
    // Compile the real Control UI owner during setup, before the HTTP request deadline starts.
    await import("./control-ui.js");
  });

  it.each(["global", "workspace", "config"] as const)(
    "keeps Custom plugin UI off by default for %s plugins",
    async (origin) => {
      await withTempConfig({
        cfg: {},
        run: async () => {
          const fixture = activateFixture(origin);
          fixture.record.trustedOfficialInstall = true;
          const catalog = await listControlUiPluginCatalog();
          expect(catalog.plugins).toEqual([]);
          expect(catalog.diagnostics).toEqual([
            {
              pluginId: fixture.record.id,
              code: "custom-plugin-ui-disabled",
              message: expect.stringContaining("Settings > Labs"),
            },
          ]);
          expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([]);
          expect(listControlUiPluginWidgetKinds(["operator.read"])).not.toContainEqual(
            expect.objectContaining({ pluginId: fixture.record.id }),
          );
          expect(await reloadControlUiPluginCatalog(fixture.record.id)).toEqual(catalog);
        },
      });
    },
  );

  it("withdraws Custom plugin UI assets and receipts when the applied lab setting turns off", async () => {
    await withTempConfig({
      cfg: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      run: async () => {
        activateFixture("workspace");
        const entry = (await listControlUiPluginCatalog()).plugins[0]!;
        expect(listControlUiPluginWidgetKinds(["operator.read"])).toContainEqual(
          expect.objectContaining({ pluginId: entry.pluginId }),
        );
        const browser = {};
        const report = {
          pluginId: entry.pluginId,
          revision: entry.revision,
          status: "activated" as const,
        };
        expect(reportControlUiPluginActivation(browser, report)).toBe(true);
        const cookie = cookieForGrant();
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { controlUiEnabled: true, controlUiBasePath: "" },
        });
        expect(
          (await sendRequest(server, { path: entry.entryUrl, headers: { cookie } })).res.statusCode,
        ).toBe(200);

        setRuntimeConfigSnapshot({
          gateway: { controlUi: { experimental: { customPlugins: false } } },
        });

        expect((await listControlUiPluginCatalog()).plugins).toEqual([]);
        expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([]);
        expect(listControlUiPluginWidgetKinds(["operator.read"])).not.toContainEqual(
          expect.objectContaining({ pluginId: entry.pluginId }),
        );
        expect(reportControlUiPluginActivation(browser, report)).toBe(false);
        expect(listControlUiPluginActivations(browser)).toEqual([]);
        const credentials: Record<string, string>[] = [
          { cookie },
          { authorization: "Bearer test-token" },
        ];
        for (const headers of credentials) {
          for (const asset of [entry.entryUrl, ...entry.styles]) {
            expect((await sendRequest(server, { path: asset, headers })).res.statusCode).toBe(404);
          }
        }
      },
    });
  });

  it.each(
    [AUTH_NONE, AUTH_TOKEN].flatMap((auth) =>
      ["", "/openclaw"].map((basePath) => ({ auth, basePath })),
    ),
  )(
    "reports and enforces native asset authentication for $auth.mode Gateways at '$basePath'",
    async ({ auth, basePath }) => {
      const requiresAuth = auth.mode !== "none";
      await withTempConfig({
        prefix: "native-ui-bootstrap-",
        cfg: { gateway: { controlUi: { basePath } } },
        run: async () => {
          activateFixture();
          const entry = (await listControlUiPluginCatalog()).plugins[0]!;
          const assetPath = `${basePath}/__openclaw__/plugins/control-ui/native-ui/`;
          expect(entry.entryUrl).toBe(`${assetPath}${entry.revision}/index.js`);
          expect(entry.styles).toEqual([`${assetPath}${entry.revision}/theme.css`]);
          const server = createTestGatewayServer({
            resolvedAuth: auth,
            overrides: { controlUiEnabled: true, controlUiBasePath: basePath },
          });
          const bootstrap = await sendRequest(server, {
            path: `${basePath}/control-ui-config.json`,
            ...(requiresAuth ? { authorization: "Bearer test-token" } : {}),
          });
          expect(bootstrap.res.statusCode).toBe(200);
          expect(JSON.parse(bootstrap.getBody())).toMatchObject({
            basePath,
            pluginAssetsRequireAuth: requiresAuth,
            pluginFrameGrants: requiresAuth
              ? [
                  {
                    pluginId: "native-ui",
                    path: assetPath,
                    match: "prefix",
                  },
                ]
              : [],
          });
          const cookieHeaders = bootstrap.setHeader.mock.calls
            .filter(([name]) => name === "Set-Cookie")
            .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
          expect(cookieHeaders).toHaveLength(requiresAuth ? 1 : 0);
          for (const header of cookieHeaders) {
            expect(header).toContain(`Path=${assetPath};`);
          }
          const cookie = cookieHeaders.map((value) => String(value).split(";")[0]).join("; ");
          for (const { assetUrl, source } of [
            { assetUrl: entry.entryUrl, source: firstSource },
            { assetUrl: entry.styles[0]!, source: "body { color: red; }" },
          ]) {
            expect((await sendRequest(server, { path: assetUrl })).res.statusCode).toBe(
              requiresAuth ? 401 : 200,
            );
            const asset = await sendRequest(server, { path: assetUrl, headers: { cookie } });
            expect(asset.res.statusCode).toBe(200);
            expect(asset.end.mock.calls[0]?.[0]?.toString()).toBe(source);
            if (basePath) {
              expect(
                (
                  await sendRequest(server, {
                    path: assetUrl.slice(basePath.length),
                    headers: { cookie },
                  })
                ).res.statusCode,
              ).toBe(404);
            }
          }
        },
      });
    },
  );

  it("serves authenticated immutable builds and preserves the last working revision on failure", async () => {
    const fixture = activateFixture();
    const firstChunk = "export const value = 'first';";
    fs.writeFileSync(path.join(fixture.directory, "lazy.js"), firstChunk);
    const first = await listControlUiPluginCatalog();
    expect(first.diagnostics).toEqual([]);
    const entry = first.plugins[0]!;
    const browser = {};
    expect(
      reportControlUiPluginActivation(browser, {
        pluginId: "native-ui",
        revision: entry.revision,
        status: "activated",
      }),
    ).toBe(true);
    const cookie = cookieForGrant();
    await withGatewayServer({
      prefix: "native-ui-http-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true, controlUiBasePath: "" },
      run: async (server) => {
        const read = (url: string, method = "GET") =>
          sendRequest(server, {
            path: url,
            method,
            headers: { cookie },
          });
        const original = await read(entry.entryUrl);
        expect(original.res.statusCode).toBe(200);
        expect(original.end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);
        expect(original.setHeader).toHaveBeenCalledWith(
          "Content-Type",
          "text/javascript; charset=utf-8",
        );
        expect((await read(entry.styles[0]!)).res.statusCode).toBe(200);
        const head = await read(entry.entryUrl, "HEAD");
        expect(head.res.statusCode).toBe(200);
        expect(head.getBody()).toBe("");
        expect((await read(entry.entryUrl, "POST")).res.statusCode).toBe(405);

        const nextSource = 'export default { id: "native-ui", version: 2 };';
        fs.writeFileSync(path.join(fixture.directory, "index.js"), nextSource);
        expect(await listControlUiPluginCatalog()).toEqual(first);
        expect((await read(entry.entryUrl)).end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);
        const next = await reloadControlUiPluginCatalog("native-ui");
        expect(next.plugins[0]!.revision).not.toBe(entry.revision);
        expect((await read(next.plugins[0]!.entryUrl)).end.mock.calls[0]?.[0]?.toString()).toBe(
          nextSource,
        );
        expect((await read(entry.entryUrl)).end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);

        expect(
          reportControlUiPluginActivation(browser, {
            pluginId: "native-ui",
            revision: next.plugins[0]!.revision,
            status: "failed",
          }),
        ).toBe(true);
        fs.writeFileSync(
          path.join(fixture.directory, "index.js"),
          "export default { version: 3 };",
        );
        fs.writeFileSync(path.join(fixture.directory, "lazy.js"), "export const value = 'third';");
        const third = await reloadControlUiPluginCatalog("native-ui");
        expect(third.diagnostics).toEqual([]);
        expect(
          reportControlUiPluginActivation(browser, {
            pluginId: "native-ui",
            revision: third.plugins[0]!.revision,
            status: "failed",
          }),
        ).toBe(true);
        // Failed activations still use the first renderer, including its later imports.
        const retainedChunk = await read(entry.entryUrl.replace(/index\.js$/u, "lazy.js"));
        expect(retainedChunk.res.statusCode).toBe(200);
        expect(retainedChunk.end.mock.calls[0]?.[0]?.toString()).toBe(firstChunk);
        expect((await read(entry.entryUrl)).end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);

        fs.unlinkSync(path.join(fixture.directory, "index.js"));
        const failed = await reloadControlUiPluginCatalog("native-ui");
        expect(failed.plugins).toEqual(third.plugins);
        expect(failed.diagnostics).toEqual([
          { pluginId: "native-ui", message: expect.stringContaining("Build the plugin") },
        ]);
        expect((await read(next.plugins[0]!.entryUrl)).res.statusCode).toBe(200);
        fixture.record.enabled = false;
        expect((await read(next.plugins[0]!.entryUrl)).res.statusCode).toBe(404);
      },
    });
  });

  it("runs queued reloads after an earlier reload rejects", async () => {
    const fixture = activateFixture();
    const first = await listControlUiPluginCatalog();
    fs.writeFileSync(
      path.join(fixture.directory, "index.js"),
      'export default { id: "native-ui", version: 2 };',
    );

    const rejected = reloadControlUiPluginCatalog("missing-plugin");
    const reloading = reloadControlUiPluginCatalog("native-ui");
    const reading = listControlUiPluginCatalog();
    const [second, listed] = await Promise.all([
      reloading,
      reading,
      expect(rejected).rejects.toThrow("No active Control UI entrypoint for this plugin"),
    ]);

    expect(second.diagnostics).toEqual([]);
    expect(second.plugins[0]!.revision).not.toBe(first.plugins[0]!.revision);
    expect(listed).toEqual(second);
    expect(await listControlUiPluginCatalog()).toEqual(second);
  });

  it.each(["cold", "initialized"] as const)(
    "serves a %s catalog when a concurrent reload rejects",
    async (initialization) => {
      activateFixture();
      const first = initialization === "initialized" ? await listControlUiPluginCatalog() : null;
      const rejected = reloadControlUiPluginCatalog("missing-plugin");
      const reading = listControlUiPluginCatalog();
      const [catalog] = await Promise.all([
        reading,
        expect(rejected).rejects.toThrow("No active Control UI entrypoint for this plugin"),
      ]);

      expect(catalog.plugins.map((plugin) => plugin.pluginId)).toEqual(["native-ui"]);
      expect(catalog.diagnostics).toEqual([]);
      if (first) {
        expect(catalog).toEqual(first);
      }
      expect(await listControlUiPluginCatalog()).toEqual(catalog);
    },
  );

  it.each([
    { limit: "256 revisions", maxChanges: 256, sourceBytes: 0 },
    { limit: "64 MiB", maxChanges: 16, sourceBytes: 4 * 1024 * 1024 },
  ])(
    "refuses reloads past $limit without evicting advertised assets",
    async ({ maxChanges, sourceBytes }) => {
      const fixture = activateFixture();
      const first = await listControlUiPluginCatalog();
      const entry = first.plugins[0]!;
      let current = first;
      let refused = false;
      for (let version = 1; version <= maxChanges; version++) {
        const source = `export default { version: ${version} };`.padEnd(sourceBytes);
        fs.writeFileSync(path.join(fixture.directory, "index.js"), source);
        const next = await reloadControlUiPluginCatalog("native-ui");
        if (next.diagnostics.length) {
          expect(next.plugins).toEqual(current.plugins);
          expect(next.diagnostics).toEqual([
            { pluginId: "native-ui", message: expect.stringContaining("Restart the Gateway") },
          ]);
          refused = true;
          break;
        }
        current = next;
      }
      expect(refused).toBe(true);
      await withGatewayServer({
        prefix: "native-ui-retained-",
        resolvedAuth: AUTH_TOKEN,
        overrides: { controlUiEnabled: true, controlUiBasePath: "" },
        run: async (server) => {
          const original = await sendRequest(server, {
            path: entry.entryUrl,
            headers: { cookie: cookieForGrant() },
          });
          expect(original.res.statusCode).toBe(200);
          expect(original.end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);
        },
      });
      // Selecting an already advertised build needs no additional cache capacity.
      fs.writeFileSync(path.join(fixture.directory, "index.js"), firstSource);
      expect((await reloadControlUiPluginCatalog("native-ui")).plugins).toEqual(first.plugins);
    },
  );

  it("requires owner-bound read grants and never serves source files, maps, or escaped paths", async () => {
    const fixture = activateFixture();
    fs.writeFileSync(path.join(fixture.directory, "source.ts"), "private source");
    fs.writeFileSync(path.join(fixture.directory, "index.js.map"), "private sourcemap");
    fs.writeFileSync(path.join(fixture.directory, ".secret.js"), "private hidden file");
    const entry = (await listControlUiPluginCatalog()).plugins[0]!;
    const cookie = cookieForGrant();
    const prefix = entry.entryUrl.slice(0, -"index.js".length);
    expect(listControlUiPluginTabAuthGrants(["operator.approvals"])).toEqual([]);
    expect(authorizeOperatorScopesForMethod("plugins.controlUi.list", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(
      authorizeOperatorScopesForMethod("plugins.controlUi.reload", ["operator.write"]),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    await withGatewayServer({
      prefix: "native-ui-auth-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true, controlUiBasePath: "" },
      run: async (server) => {
        const unauthorizedHeaders: Record<string, string>[] = [
          {},
          { cookie: cookieForGrant({ pluginId: "another-owner" }) },
          { cookie: cookieForGrant({ generation: "stale-generation" }) },
        ];
        for (const headers of unauthorizedHeaders) {
          expect(
            (await sendRequest(server, { path: entry.entryUrl, headers })).res.statusCode,
          ).toBe(401);
        }
        expect(
          (await sendRequest(server, { path: entry.entryUrl, authorization: "Bearer test-token" }))
            .res.statusCode,
        ).toBe(200);
        for (const suffix of [
          "source.ts",
          "index.js.map",
          ".secret.js",
          "%2e%2e%2fserver.js",
          "%252e%252e/server.js",
          "missing.js",
        ]) {
          expect(
            (await sendRequest(server, { path: prefix + suffix, headers: { cookie } })).res
              .statusCode,
            suffix,
          ).toBe(404);
        }
      },
    });
  });

  it.each(["symlink", "hardlink"])(
    "rejects %s browser files outside their built owner",
    async (kind) => {
      const fixture = activateFixture();
      const privatePath = path.join(fixture.rootDir, "private.js");
      fs.writeFileSync(privatePath, "private source");
      const entry = path.join(fixture.directory, "index.js");
      fs.unlinkSync(entry);
      if (kind === "symlink") {
        fs.symlinkSync(privatePath, entry);
      } else {
        fs.linkSync(privatePath, entry);
      }
      const catalog = await listControlUiPluginCatalog();
      expect(catalog.plugins).toEqual([]);
      expect(catalog.diagnostics).toEqual([{ pluginId: "native-ui", message: expect.any(String) }]);
    },
  );

  it("adopts an immutable manifest publication only on explicit reload and retires old browser receipts", async () => {
    const fixture = activateFixture();
    const first = await listControlUiPluginCatalog();
    const browser = {};
    const report = {
      pluginId: "native-ui",
      revision: first.plugins[0]!.revision,
      status: "activated" as const,
    };
    expect(reportControlUiPluginActivation(browser, report)).toBe(true);
    expect(listControlUiPluginActivations(browser)).toEqual([report]);
    expect(listControlUiPluginActivations({})).toEqual([]);
    const nextDirectory = path.join(fixture.directory, "published");
    fs.mkdirSync(nextDirectory);
    fs.writeFileSync(path.join(nextDirectory, "index.js"), "export default { version: 2 };");
    fs.writeFileSync(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "native-ui",
        configSchema: { type: "object" },
        controlUi: { entry: "dist/control-ui/published/index.js" },
      }),
    );
    expect(await listControlUiPluginCatalog()).toEqual(first);
    const second = await reloadControlUiPluginCatalog("native-ui");
    expect(second.diagnostics).toEqual([]);
    expect(second.plugins[0]!.revision).not.toBe(report.revision);
    expect(fixture.record.controlUi?.entry).toBe("dist/control-ui/index.js");
    expect(listControlUiPluginActivations(browser)).toEqual([]);
    expect(reportControlUiPluginActivation(browser, report)).toBe(false);
    const pending = {
      ...report,
      revision: second.plugins[0]!.revision,
      status: "failed" as const,
      error: "Activation failed",
    };
    expect(reportControlUiPluginActivation(browser, pending)).toBe(true);
    expect(listControlUiPluginActivations(browser)).toEqual([pending]);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(reportControlUiPluginActivation(browser, pending)).toBe(false);
  });

  it("fences a queued reload after registry replacement and rebuilds a reactivated generation", async () => {
    const fixture = activateFixture();
    const first = await listControlUiPluginCatalog();
    const pending = reloadControlUiPluginCatalog("native-ui");
    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(pending).rejects.toThrow("no longer active");
    expect((await listControlUiPluginCatalog()).plugins).toEqual([]);
    fs.writeFileSync(path.join(fixture.directory, "index.js"), "export default {};");
    setActivePluginRegistry(fixture.registry);
    const second = await listControlUiPluginCatalog();
    expect(second.plugins[0]!.revision).not.toBe(first.plugins[0]!.revision);
  });
});
