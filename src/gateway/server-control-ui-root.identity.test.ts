/** Exercises source UI preparation against the Gateway's loaded build identity. */
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeRetentionBuild } from "./control-ui-asset-retention.test-support.js";

const fixture = vi.hoisted(() => ({
  root: "",
  selectedRoot: "",
  buildId: "2026.9.1-runtime-b",
  build: vi.fn(),
}));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => fixture.root,
  resolveOpenClawPackageRootSync: () => fixture.root,
}));
vi.mock("../infra/control-ui-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/control-ui-assets.js")>()),
  resolveControlUiRootSync: () => fixture.selectedRoot,
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: fixture.build }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => fixture.buildId,
}));

import { handleControlUiHttpRequest, type ControlUiRootState } from "./control-ui.js";
import { createGatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import { makeMockHttpResponse } from "./test-http-response.js";

async function requestIndex(root: ControlUiRootState) {
  const response = makeMockHttpResponse();
  await handleControlUiHttpRequest(
    { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
    response.res,
    { root },
  );
  return response;
}

async function writeUi(root: string, buildId: string) {
  await writeRetentionBuild(root, buildId, { assetPath: "assets/startup.js" });
  await fs.writeFile(
    path.join(root, "index.html"),
    `<html data-openclaw-control-ui-build-id="${buildId}-${"a".repeat(64)}"><script src="./assets/startup.js"></script></html>`,
  );
}

function createLifecycle(override?: string) {
  const warn = vi.fn();
  const lifecycle = createGatewayControlUiRootLifecycle({
    controlUiRootOverride: override,
    controlUiEnabled: true,
    gatewayRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    log: { warn },
  });
  return { lifecycle, warn };
}

describe("source-selected Control UI identity preparation", () => {
  beforeEach(async () => {
    fixture.buildId = "2026.9.1-runtime-b";
    fixture.root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-identity-")),
    );
    fixture.selectedRoot = path.join(fixture.root, "dist", "control-ui");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture.root, "state"));
    await fs.mkdir(path.join(fixture.root, "ui"));
    await fs.mkdir(path.join(fixture.root, "scripts"));
    await fs.writeFile(path.join(fixture.root, "ui", "vite.config.ts"), "export {};");
    await fs.writeFile(path.join(fixture.root, "scripts", "ui.js"), "");
    await writeUi(fixture.selectedRoot, "2026.9.1-runtime-a");
    fixture.build.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  test("prepares a complete stale source UI before publishing its shared root", async () => {
    const selectedRoot = fixture.selectedRoot;
    const buildId = fixture.buildId;
    const provenancePath = path.join(fixture.root, "dist", "build-info.json");
    const provenance = JSON.stringify({ buildId });
    await fs.writeFile(provenancePath, provenance);
    let finishBuild!: () => Promise<void>;
    fixture.build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBuild = async () => {
            await writeUi(selectedRoot, buildId);
            resolve({
              stdout: "",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            });
          };
        }),
    );
    const { lifecycle, warn } = createLifecycle();
    const rootReference = lifecycle.state;
    expect(rootReference).toEqual({ kind: "preparing" });
    const unavailable = await requestIndex(rootReference);
    expect(unavailable.res.statusCode).toBe(503);
    expect(unavailable.setHeader).toHaveBeenCalledWith("Retry-After", "1");

    const preparing = lifecycle.start();
    expect(lifecycle.start()).toBe(preparing);
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledOnce());
    expect(rootReference).toEqual({ kind: "preparing" });
    fixture.selectedRoot = path.join(fixture.root, "other", "control-ui");
    fixture.buildId = "2026.9.1-runtime-c";
    await writeUi(fixture.selectedRoot, fixture.buildId);
    await finishBuild();
    await preparing;

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toMatchObject({
      kind: "bundled",
      path: selectedRoot,
      publicAssetBuildId: `${buildId}-${"a".repeat(64)}`,
    });
    const ready = await requestIndex(rootReference);
    expect(ready.res.statusCode).toBe(200);
    expect(String(ready.end.mock.calls[0]?.[0])).toContain(`${buildId}-${"a".repeat(64)}`);
    await lifecycle.start();
    await lifecycle.stop();
    expect(fixture.build).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(await fs.readFile(provenancePath, "utf8")).toBe(provenance);
  });

  test.each(["matching", "dev", "configured", "macOS"])(
    "preserves the %s root without rebuilding",
    async (kind) => {
      if (kind === "macOS") {
        fixture.selectedRoot = path.join(
          fixture.root,
          "OpenClaw.app",
          "Contents",
          "Resources",
          "control-ui",
        );
      }
      await writeUi(
        fixture.selectedRoot,
        kind === "dev" ? "dev" : kind === "configured" ? "custom-build" : fixture.buildId,
      );
      const { lifecycle, warn } = createLifecycle(
        kind === "configured" ? fixture.selectedRoot : undefined,
      );
      expect(lifecycle.state).toMatchObject({
        kind: kind === "configured" || kind === "macOS" ? "resolved" : "bundled",
        path: fixture.selectedRoot,
      });
      await lifecycle.start();
      await lifecycle.stop();
      expect(fixture.build).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("reports an unchanged UI after a successful builder instead of publishing it", async () => {
    fixture.build.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    const { lifecycle, warn } = createLifecycle();
    await lifecycle.start();
    await lifecycle.stop();
    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("expected 2026.9.1-runtime-b"));
    expect(fixture.build).toHaveBeenCalledOnce();
  });

  test.each(["stale", "incomplete"])(
    "does not mask %s macOS Resources with a healthy source dist",
    async (kind) => {
      await writeUi(fixture.selectedRoot, fixture.buildId);
      fixture.selectedRoot = path.join(
        fixture.root,
        "OpenClaw.app",
        "Contents",
        "Resources",
        "control-ui",
      );
      await writeUi(fixture.selectedRoot, "2026.9.1-runtime-a");
      if (kind === "incomplete") {
        await fs.unlink(path.join(fixture.selectedRoot, "assets", "startup.js"));
      }
      const { lifecycle, warn } = createLifecycle();
      expect(lifecycle.state).toEqual({ kind: "preparing" });
      await lifecycle.start();
      await lifecycle.stop();
      expect(lifecycle.state).toEqual({ kind: "failed" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(fixture.selectedRoot));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Reinstall OpenClaw"));
      expect(fixture.build).not.toHaveBeenCalled();
    },
  );
});
