import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
};

type PnpmWorkspaceConfig = {
  overrides?: Record<string, string>;
};

const PI_PACKAGE_NAMES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

function readPnpmWorkspaceConfig(): PnpmWorkspaceConfig {
  const workspacePath = path.resolve(process.cwd(), "pnpm-workspace.yaml");
  return YAML.parse(fs.readFileSync(workspacePath, "utf8")) as PnpmWorkspaceConfig;
}

function isExactPinnedVersion(spec: string): boolean {
  return !spec.startsWith("^") && !spec.startsWith("~");
}

function isPiOverrideKey(key: string): boolean {
  return key.startsWith("@mariozechner/pi-") || key.includes("@mariozechner/pi-");
}

function readPiDependencySpecs() {
  const dependencies = readRootManifest().dependencies ?? {};
  return PI_PACKAGE_NAMES.map((name) => ({
    name,
    spec: dependencies[name],
  }));
}

function collectMissingSpecNames(specs: Array<{ name: string; spec?: string }>): string[] {
  const names: string[] = [];
  for (const entry of specs) {
    if (!entry.spec) {
      names.push(entry.name);
    }
  }
  return names;
}

function expectNoGraphViolations(violations: string[], message: string) {
  expect(violations, message).toStrictEqual([]);
}

describe("pi package graph guardrails", () => {
  it("keeps root Pi packages aligned to the same exact version", () => {
    const specs = readPiDependencySpecs();

    const missing = collectMissingSpecNames(specs);
    expectNoGraphViolations(
      missing,
      `Missing required root Pi dependencies: ${missing.join(", ") || "<none>"}. Mixed or incomplete Pi root dependencies create an unsupported package graph.`,
    );

    const presentSpecs = specs.map((entry) => entry.spec);
    const uniqueSpecs = [...new Set(presentSpecs)];
    expect(
      uniqueSpecs,
      `Root Pi dependencies must stay aligned to one exact version. Found: ${specs.map((entry) => `${entry.name}=${entry.spec}`).join(", ")}. Mixed Pi versions create an unsupported package graph.`,
    ).toHaveLength(1);

    const inexact = specs.filter((entry) => !isExactPinnedVersion(entry.spec));
    expectNoGraphViolations(
      inexact.map((entry) => `${entry.name}=${entry.spec}`),
      `Root Pi dependencies must use exact pins, not ranges. Found: ${inexact.map((entry) => `${entry.name}=${entry.spec}`).join(", ") || "<none>"}. Range-based Pi specs can silently create an unsupported package graph.`,
    );
  });

  it("forbids pnpm overrides that target Pi packages", () => {
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const overrides = pnpmWorkspace.overrides ?? {};
    const piOverrides = Object.keys(overrides).filter(isPiOverrideKey);

    expectNoGraphViolations(
      piOverrides,
      `pnpm-workspace.yaml overrides must not target Pi packages. Found: ${piOverrides.join(", ") || "<none>"}. Pi-specific overrides can silently create an unsupported package graph.`,
    );
  });
});
