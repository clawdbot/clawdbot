import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  listControlUiPluginCatalog,
  listControlUiPluginActivations,
  reportControlUiPluginActivation,
  reloadControlUiPluginCatalog,
} from "./control-ui-plugin-assets.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import { listControlUiPluginTabAuthGrants } from "./control-ui-plugin-tabs.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  createResponse,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const roots: string[] = [];
const firstSource = 'export default { id: "native-ui" };';

function activateFixture() {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-")));
  roots.push(rootDir);
  const directory = path.join(rootDir, "dist/control-ui");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.js"), firstSource);
  fs.writeFileSync(path.join(directory, "theme.css"), "body { color: red; }");
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "native-ui",
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
  setActivePluginRegistry(registry);
  return { rootDir, directory, registry, record };
}

function cookieForGrant(overrides: { pluginId?: string; generation?: string } = {}) {
  const response = createResponse();
  const [grant] = listControlUiPluginTabAuthGrants(["operator.read"]);
  expect(grant).toBeDefined();
  setControlUiPluginAuthCookie(
    response.res,
    [{ ...grant!, pluginId: overrides.pluginId ?? grant!.pluginId }],
    {
      generation: overrides.generation ?? resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
    },
  );
  const value = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const cookie = Array.isArray(value) ? value[0] : value;
  if (typeof cookie !== "string") {
    throw new Error("Expected scoped Control UI cookie");
  }
  return cookie.split(";")[0];
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  for (const rootDir of roots.splice(0)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("native Control UI browser assets", () => {
  it.each([AUTH_NONE, AUTH_TOKEN])(
    "reports and enforces native asset authentication for $mode Gateways",
    async (auth) => {
      activateFixture();
      const entry = (await listControlUiPluginCatalog()).plugins[0]!;
      const requiresAuth = auth.mode !== "none";
      await withGatewayServer({
        prefix: "native-ui-bootstrap-",
        resolvedAuth: auth,
        overrides: { controlUiEnabled: true, controlUiBasePath: "" },
        run: async (server) => {
          const bootstrap = await sendRequest(server, {
            path: "/control-ui-config.json",
            ...(requiresAuth ? { authorization: "Bearer test-token" } : {}),
          });
          expect(bootstrap.res.statusCode).toBe(200);
          expect(JSON.parse(bootstrap.getBody())).toMatchObject({
            pluginAssetsRequireAuth: requiresAuth,
            pluginFrameGrants: requiresAuth
              ? [
                  {
                    pluginId: "native-ui",
                    path: "/__openclaw__/plugins/control-ui/native-ui/",
                    match: "prefix",
                  },
                ]
              : [],
          });
          const cookieHeaders = bootstrap.setHeader.mock.calls
            .filter(([name]) => name === "Set-Cookie")
            .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
          expect(cookieHeaders).toHaveLength(requiresAuth ? 1 : 0);
          expect((await sendRequest(server, { path: entry.entryUrl })).res.statusCode).toBe(
            requiresAuth ? 401 : 200,
          );
          if (requiresAuth) {
            const cookie = cookieHeaders.map((value) => String(value).split(";")[0]).join("; ");
            const asset = await sendRequest(server, { path: entry.entryUrl, headers: { cookie } });
            expect(asset.res.statusCode).toBe(200);
            expect(asset.end.mock.calls[0]?.[0]?.toString()).toBe(firstSource);
          }
        },
      });
    },
  );

  it("serves authenticated immutable builds and preserves the last working revision on failure", async () => {
    const fixture = activateFixture();
    const first = await listControlUiPluginCatalog();
    expect(first.diagnostics).toEqual([]);
    const entry = first.plugins[0]!;
    const cookie = cookieForGrant();
    await withGatewayServer({
      prefix: "native-ui-http-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true },
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

        fs.unlinkSync(path.join(fixture.directory, "index.js"));
        const failed = await reloadControlUiPluginCatalog("native-ui");
        expect(failed.plugins).toEqual(next.plugins);
        expect(failed.diagnostics).toEqual([
          { pluginId: "native-ui", message: expect.stringContaining("Build the plugin") },
        ]);
        expect((await read(next.plugins[0]!.entryUrl)).res.statusCode).toBe(200);
        fixture.record.enabled = false;
        expect((await read(next.plugins[0]!.entryUrl)).res.statusCode).toBe(404);
      },
    });
  });

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
      overrides: { controlUiEnabled: true },
      run: async (server) => {
        for (const headers of [
          {},
          { cookie: cookieForGrant({ pluginId: "another-owner" }) },
          { cookie: cookieForGrant({ generation: "stale-generation" }) },
        ]) {
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
