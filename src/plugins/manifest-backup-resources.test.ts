import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveActivatedPluginBackupInventory } from "./manifest-backup-resources.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const roots: string[] = [];

function createPluginFixture(params: {
  id?: string;
  backupResources: unknown;
  root?: string;
  workspace?: boolean;
}) {
  const root =
    params.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-owner-")));
  if (!params.root) {
    roots.push(root);
  }
  const id = params.id ?? "backup-owner";
  const workspaceDir = path.join(root, "workspace");
  const pluginRoot = params.workspace
    ? path.join(workspaceDir, ".openclaw", "extensions", id)
    : path.join(root, id);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", additionalProperties: false },
      backupResources: params.backupResources,
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.ts"),
    'throw new Error("plugin runtime activated")',
  );
  return {
    id,
    pluginRoot,
    stateDir,
    workspaceDir,
    env: {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "no-bundled-plugins"),
    },
  };
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin manifest backup resources", () => {
  it("retains closed resource declarations and removes deterministic duplicates", () => {
    const include = { disposition: "include", scope: "state", relativePath: "owner/durable" };
    const regenerable = {
      disposition: "regenerable",
      scope: "agent",
      relativePath: "owner/cache",
    };
    const fixture = createPluginFixture({
      backupResources: [include, regenerable, include],
    });

    const result = loadPluginManifest(fixture.pluginRoot);

    expect(result).toMatchObject({
      ok: true,
      manifest: { backupResources: [regenerable, include] },
    });
  });

  it.each([
    ["an absolute POSIX path", "/outside"],
    ["a Windows absolute path", "C:\\outside"],
    ["a Windows drive-relative path", "C:outside"],
    ["a Windows UNC path", "\\\\server\\share"],
    ["a backslash separator", "owner\\cache"],
    ["a NUL byte", "owner/\0cache"],
    ["an empty path", ""],
    ["an empty segment", "owner//cache"],
    ["a trailing empty segment", "owner/cache/"],
    ["a current-directory segment", "owner/./cache"],
    ["a parent-directory segment", "owner/../outside"],
    ["a URI-like value", "https://example.com/cache"],
  ])("rejects %s", (_label, relativePath) => {
    const fixture = createPluginFixture({
      backupResources: [{ disposition: "include", scope: "state", relativePath }],
    });

    expect(loadPluginManifest(fixture.pluginRoot)).toMatchObject({
      ok: false,
      error: expect.stringContaining("strict relative POSIX path"),
    });
  });

  it.each([
    ["non-array declarations", {}],
    ["unknown disposition", [{ disposition: "exclude", scope: "state", relativePath: "owner" }]],
    ["unknown scope", [{ disposition: "include", scope: "workspace", relativePath: "owner" }]],
    [
      "owner-controlled extra keys",
      [{ disposition: "include", scope: "state", relativePath: "owner", pluginId: "spoofed" }],
    ],
    ["missing keys", [{ disposition: "include", relativePath: "owner" }]],
  ])("rejects %s", (_label, backupResources) => {
    const fixture = createPluginFixture({ backupResources });

    expect(loadPluginManifest(fixture.pluginRoot)).toMatchObject({
      ok: false,
      error: expect.stringContaining("backupResources"),
      diagnosticCode: "backup-resource-declaration-invalid",
    });
  });

  it("resolves only activated loadable owners without activating plugin runtime", () => {
    const included = {
      disposition: "include",
      scope: "state",
      relativePath: "plugins/backup-owner/durable",
    } as const;
    const regenerable = {
      disposition: "regenerable",
      scope: "agent",
      relativePath: "backup-owner/cache",
    } as const;
    const enabled = createPluginFixture({ backupResources: [included, regenerable, included] });
    const disabled = createPluginFixture({
      root: path.dirname(enabled.pluginRoot),
      id: "disabled-owner",
      backupResources: [{ ...regenerable, relativePath: "disabled-owner/cache" }],
    });
    const config: OpenClawConfig = {
      plugins: {
        allow: [enabled.id, disabled.id],
        load: { paths: [enabled.pluginRoot, disabled.pluginRoot] },
        entries: {
          [enabled.id]: { enabled: true },
          [disabled.id]: { enabled: false },
        },
      },
    };

    expect(
      resolveActivatedPluginBackupInventory({
        config,
        env: enabled.env,
        stateDir: enabled.stateDir,
        workspaceDirs: [path.join(path.dirname(enabled.pluginRoot), "workspace")],
      }),
    ).toEqual({
      pluginRoots: [],
      resources: [
        { pluginId: enabled.id, ...regenerable },
        { pluginId: enabled.id, ...included },
      ],
    });
  });

  it("fails closed on invalid declarations from an activated manifest owner", () => {
    const fixture = createPluginFixture({
      backupResources: [{ disposition: "include", scope: "state", relativePath: "../outside" }],
    });
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: [fixture.pluginRoot] },
        entries: { [fixture.id]: { enabled: true } },
      },
    };

    expect(() =>
      resolveActivatedPluginBackupInventory({
        config,
        env: fixture.env,
        stateDir: fixture.stateDir,
      }),
    ).toThrow("invalid plugin manifest backupResources");
  });

  it.each([
    { label: "ignores", activated: false },
    { label: "fails closed on", activated: true },
  ])(
    "$label invalid declarations from a workspace owner when activated=$activated",
    ({ activated }) => {
      const fixture = createPluginFixture({
        workspace: true,
        backupResources: [{ disposition: "include", scope: "state", relativePath: "../outside" }],
      });
      const config: OpenClawConfig = {
        plugins: {
          allow: [fixture.id],
          entries: { [fixture.id]: { enabled: activated } },
        },
      };
      const resolveInventory = () =>
        resolveActivatedPluginBackupInventory({
          config,
          env: fixture.env,
          stateDir: fixture.stateDir,
          workspaceDirs: [fixture.workspaceDir],
        });

      if (activated) {
        expect(resolveInventory).toThrow("invalid plugin manifest backupResources");
      } else {
        expect(resolveInventory()).toEqual({ pluginRoots: [fixture.pluginRoot], resources: [] });
      }
    },
  );

  it("does not apply declarations when the plugin system is disabled", () => {
    const fixture = createPluginFixture({
      backupResources: [{ disposition: "include", scope: "state", relativePath: "owner" }],
    });

    expect(
      resolveActivatedPluginBackupInventory({
        config: {
          plugins: { enabled: false, load: { paths: [fixture.pluginRoot] } },
        },
        env: fixture.env,
        stateDir: fixture.stateDir,
      }),
    ).toEqual({ pluginRoots: [], resources: [] });
  });
});
