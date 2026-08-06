import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import { listRegisteredHostIntegrationBundles } from "./host-integration-bundle-registry.js";
import {
  HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION,
  parsePluginManifestHostIntegrationBundle,
  type PluginManifestHostIntegrationBundle,
} from "./host-integration-bundle.js";
import { createPluginRecord } from "./loader-records.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-bundle-"));
  tempDirs.push(dir);
  return dir;
}

function contribution(id: string) {
  return {
    owner: "provider-request",
    kind: "credential-slot-resolver",
    id,
    contractVersion: "credential-slot-resolver/v1",
  };
}

function bundle(
  id = "lobster/host",
  contributions: unknown[] = [contribution("lobster/capi-token")],
): Record<string, unknown> {
  return {
    contractVersion: HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION,
    id,
    version: "1.0.0",
    contributions,
  };
}

function writeManifest(rootDir: string, id: string, hostIntegrationBundle: unknown): void {
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      hostIntegrationBundle,
    }),
    "utf-8",
  );
}

function candidate(rootDir: string, idHint: string): PluginCandidate {
  return {
    idHint,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "workspace",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("host integration bundle manifest", () => {
  it("normalizes and freezes an inert contribution inventory", () => {
    const result = parsePluginManifestHostIntegrationBundle(
      bundle("lobster/host", [
        {
          owner: "model-provider",
          kind: "model-provider-adapter",
          id: "lobster/capi",
          contractVersion: "capi-model-provider-adapter/v1",
        },
        contribution("lobster/capi-token"),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.bundle) {
      throw new Error("expected bundle");
    }
    expect(result.bundle).toMatchObject({
      id: "lobster/host",
      version: "1.0.0",
      contributions: [{ id: "lobster/capi" }, { id: "lobster/capi-token" }],
    });
    expect(Object.isFrozen(result.bundle)).toBe(true);
    expect(Object.isFrozen(result.bundle.contributions)).toBe(true);
    expect(result.bundle.contributions.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ["unsupported contract", { ...bundle(), contractVersion: "host-integration-bundle/v2" }],
    ["unscoped bundle id", bundle("lobster")],
    ["non-exact version", { ...bundle(), version: "^1.0.0" }],
    ["empty inventory", bundle("lobster/host", [])],
    [
      "duplicate contribution",
      bundle("lobster/host", [
        contribution("lobster/capi-token"),
        contribution("lobster/capi-token"),
      ]),
    ],
    [
      "readiness field",
      bundle("lobster/host", [
        {
          ...contribution("lobster/capi-token"),
          readinessCriterion: "provider.request.credentials",
        },
      ]),
    ],
  ])("rejects %s", (_label, value) => {
    expect(parsePluginManifestHostIntegrationBundle(value)).toMatchObject({ ok: false });
  });

  it("loads the declaration from openclaw.plugin.json without importing runtime code", () => {
    const dir = makeTempDir();
    writeManifest(dir, "lobster-host", bundle());

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.hostIntegrationBundle?.id).toBe("lobster/host");
  });

  it("rejects duplicate bundle ownership across the manifest registry", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeManifest(first, "lobster-host-a", bundle());
    writeManifest(second, "lobster-host-b", bundle());

    const registry = loadPluginManifestRegistry({
      candidates: [candidate(first, "lobster-host-a"), candidate(second, "lobster-host-b")],
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual([
      "lobster-host-a",
      "lobster-host-b",
    ]);
    expect(registry.plugins.every((plugin) => plugin.hostIntegrationBundle === undefined)).toBe(
      true,
    );
    expect(
      registry.diagnostics.filter((entry) =>
        entry.message.includes('host integration bundle id "lobster/host"'),
      ),
    ).toHaveLength(2);
  });

  it("returns only enabled, non-failed bundles with loader-owned provenance", () => {
    const parsed = parsePluginManifestHostIntegrationBundle(bundle());
    if (!parsed.ok || !parsed.bundle) {
      throw new Error("expected bundle");
    }
    const hostBundle = parsed.bundle satisfies PluginManifestHostIntegrationBundle;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "lobster-host",
        source: "/plugins/lobster-host/index.js",
        rootDir: "/plugins/lobster-host",
        origin: "workspace",
        enabled: true,
        configSchema: true,
        hostIntegrationBundle: hostBundle,
      }),
      createPluginRecord({
        id: "disabled-host",
        source: "/plugins/disabled/index.js",
        origin: "global",
        enabled: false,
        configSchema: true,
        hostIntegrationBundle: hostBundle,
      }),
    );

    expect(listRegisteredHostIntegrationBundles(registry)).toEqual([
      {
        pluginId: "lobster-host",
        source: "/plugins/lobster-host/index.js",
        rootDir: "/plugins/lobster-host",
        origin: "workspace",
        bundle: hostBundle,
      },
    ]);
  });
});
