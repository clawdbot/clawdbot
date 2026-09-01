import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";

const installers = vi.hoisted(() => ({ npm: vi.fn(), clawhub: vi.fn() }));
vi.mock("./install.js", () => ({ installPluginFromNpmSpec: installers.npm }));
vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: installers.clawhub,
  CLAWHUB_INSTALL_ERROR_CODE: { PACKAGE_NOT_FOUND: "package_not_found" },
}));
vi.mock("./bundled-sources.js", () => ({ resolveBundledPluginSources: () => new Map() }));

const tempDirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("channel migration artifact consent", () => {
  it.each(
    (["npm", "clawhub", "fallback"] as const).flatMap((source) =>
      (["absent", "accept", "stale", "replaced", "throw"] as const).map((review) => ({
        source,
        review,
      })),
    ),
  )("$source with $review consent protects payload and acceptance", async ({ source, review }) => {
    const root = makeTrackedTempDir("openclaw-channel-consent", tempDirs);
    const pluginId = "channel-consent-fixture";
    const packageName = `@openclaw/${pluginId}`;
    const installedDir = path.join(root, "extensions", pluginId);
    const stagedDir = path.join(root, "stage");
    function writeArtifact(dir: string, version: string, providers: string[]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: packageName, version, openclaw: { extensions: ["./index.js"] } }),
      );
      fs.writeFileSync(
        path.join(dir, "index.js"),
        `export default () => ${JSON.stringify(version)};`,
      );
      fs.writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({ id: pluginId, providers, configSchema: { type: "object" } }),
      );
    }
    writeArtifact(installedDir, "1.0.0", ["existing-provider"]);
    writeArtifact(stagedDir, "2.0.0", ["existing-provider", "new-provider"]);
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      HOME: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    const previousSurface = resolvePluginArtifactDeclaredSurface(installedDir, env);
    const config: OpenClawConfig = {
      plugins: {
        entries: { [pluginId]: { enabled: true } },
        load: { paths: [installedDir] },
        installs: {
          [pluginId]: {
            source: "path",
            sourcePath: installedDir,
            installPath: installedDir,
            version: "1.0.0",
            integrity: "sha512-previous",
            acceptedSurface: previousSurface,
            acceptedSurfaceHash: computeDeclaredSurfaceHash(previousSurface),
            acceptedSurfaceIntegrity: "sha512-previous",
            acceptedSurfaceAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    const originalConfig = structuredClone(config);
    const oldBytes = fs.readFileSync(path.join(installedDir, "index.js"), "utf8");
    let committed = false;
    const install = async (options: {
      onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    }) => {
      await options.onBeforePluginArtifactCommit?.({
        pluginId,
        stagedArtifactDir: stagedDir,
        currentArtifactDir: installedDir,
        mode: "update",
      });
      fs.cpSync(stagedDir, installedDir, { recursive: true });
      committed = true;
      return {
        ok: true as const,
        pluginId,
        targetDir: installedDir,
        version: "2.0.0",
        npmResolution: {
          name: packageName,
          version: "2.0.0",
          resolvedSpec: `${packageName}@2.0.0`,
          integrity: "sha512-next",
        },
        clawhub: {
          source: "clawhub" as const,
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: pluginId,
          clawhubFamily: "code-plugin" as const,
          integrity: "sha256-next",
        },
      };
    };
    installers.npm.mockImplementation(install);
    installers.clawhub.mockImplementation(install);
    if (source === "fallback") {
      installers.clawhub.mockResolvedValueOnce({
        ok: false,
        code: "package_not_found",
        error: "not found",
      });
    }
    const callbackError = new Error("operator review failed");
    const onCapabilityConsent = vi.fn(async (details: { reviewToken: string }) => {
      if (review === "throw") {
        throw callbackError;
      }
      if (review === "replaced") {
        writeArtifact(stagedDir, "2.0.0", [
          "existing-provider",
          "new-provider",
          "unreviewed-provider",
        ]);
      }
      return { reviewToken: review === "stale" ? "stale-token" : details.reviewToken };
    });
    const operation = syncPluginsForUpdateChannel({
      config,
      env,
      channel: "stable",
      externalizedBundledPluginBridges: [
        {
          bundledPluginId: pluginId,
          preferredSource: source === "npm" ? "npm" : "clawhub",
          npmSpec: packageName,
          clawhubSpec: pluginId,
        },
      ],
      onCapabilityConsent: review === "absent" ? undefined : onCapabilityConsent,
    });
    if (review === "throw") {
      await expect(operation).rejects.toBe(callbackError);
    } else {
      const result = await operation;
      expect(result.changed).toBe(review === "accept");
      if (review === "accept") {
        const declared = resolvePluginArtifactDeclaredSurface(installedDir, env);
        expect(declared.providers).toEqual(["existing-provider", "new-provider"]);
        expect(result.config.plugins?.installs?.[pluginId]).toMatchObject({
          version: "2.0.0",
          acceptedSurface: declared,
          acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
          acceptedSurfaceIntegrity: source === "clawhub" ? "sha256-next" : "sha512-next",
        });
        expect(result.summary.errors).toEqual([]);
      } else {
        expect(result.config).toEqual(originalConfig);
        expect(result.summary.errors.join("\n")).toMatch(/capabilit/i);
      }
    }
    expect(committed).toBe(review === "accept");
    expect(config).toEqual(originalConfig);
    if (review !== "accept") {
      expect(fs.readFileSync(path.join(installedDir, "index.js"), "utf8")).toBe(oldBytes);
    }
    if (review !== "absent") {
      expect(onCapabilityConsent).toHaveBeenCalledOnce();
    }
    if (source === "clawhub") {
      expect(installers.npm).not.toHaveBeenCalled();
    }
  });
});
