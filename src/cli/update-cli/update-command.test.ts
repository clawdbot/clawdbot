import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGatewayInstallEntrypointCandidates as resolveGatewayInstallEntrypointCandidates,
  resolveGatewayInstallEntrypoint,
} from "../../daemon/gateway-entrypoint.js";
import {
  shouldPrepareUpdatedInstallRestart,
  shouldUseLegacyProcessRestartAfterUpdate,
} from "./update-command.js";

describe("resolveGatewayInstallEntrypointCandidates", () => {
  it("prefers index.js before legacy entry.js", () => {
    expect(resolveGatewayInstallEntrypointCandidates("/tmp/openclaw-root")).toEqual([
      path.join("/tmp/openclaw-root", "dist", "index.js"),
      path.join("/tmp/openclaw-root", "dist", "index.mjs"),
      path.join("/tmp/openclaw-root", "dist", "entry.js"),
      path.join("/tmp/openclaw-root", "dist", "entry.mjs"),
    ]);
  });
});

describe("resolveGatewayInstallEntrypoint", () => {
  it("prefers dist/index.js over dist/entry.js when both exist", async () => {
    const root = "/tmp/openclaw-root";
    const indexPath = path.join(root, "dist", "index.js");
    const entryPath = path.join(root, "dist", "entry.js");

    await expect(
      resolveGatewayInstallEntrypoint(
        root,
        async (candidate) => candidate === indexPath || candidate === entryPath,
      ),
    ).resolves.toBe(indexPath);
  });

  it("falls back to dist/entry.js when index.js is missing", async () => {
    const root = "/tmp/openclaw-root";
    const entryPath = path.join(root, "dist", "entry.js");

    await expect(
      resolveGatewayInstallEntrypoint(root, async (candidate) => candidate === entryPath),
    ).resolves.toBe(entryPath);
  });
});

describe("shouldPrepareUpdatedInstallRestart", () => {
  it("prepares package update restarts when the service is installed but stopped", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "npm",
        serviceInstalled: true,
        serviceLoaded: false,
      }),
    ).toBe(true);
  });

  it("does not install a new service for package updates when no service exists", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "npm",
        serviceInstalled: false,
        serviceLoaded: false,
      }),
    ).toBe(false);
  });

  it("keeps non-package updates tied to the loaded service state", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "git",
        serviceInstalled: true,
        serviceLoaded: false,
      }),
    ).toBe(false);
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "git",
        serviceInstalled: true,
        serviceLoaded: true,
      }),
    ).toBe(true);
  });
});

describe("shouldUseLegacyProcessRestartAfterUpdate", () => {
  it("never restarts package updates through the pre-update process", () => {
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "npm" })).toBe(false);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "pnpm" })).toBe(false);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "bun" })).toBe(false);
  });

  it("keeps the in-process restart path for non-package updates", () => {
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "git" })).toBe(true);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "unknown" })).toBe(true);
  });
});
