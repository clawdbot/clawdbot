import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packToArchive } from "../plugins/test-helpers/archive-fixtures.js";
import {
  executePluginArtifactActivation,
  prepareSystemAgentPluginArtifact,
} from "./plugin-artifact.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

type ManagedInstallParams = Parameters<
  typeof import("../plugins/management-mutations.js").installManagedPlugin
>[0];

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  audit: vi.fn(),
  parsed: {} as Record<string, unknown>,
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => {},
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    config: {},
    parsed: mocks.parsed,
    hash: "config",
  }),
}));
vi.mock("./inference-route.js", () => ({
  projectDefaultInferenceRoute: async () => ({ route: null }),
  projectInferenceRoute: vi.fn(),
  sameDefaultInferenceRoute: vi.fn(),
}));
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: mocks.audit }));
vi.mock("../plugins/management-mutations.js", () => ({ installManagedPlugin: mocks.install }));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _params: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => await run({ assertOwned: () => {} }),
}));

describe("exact system-agent plugin artifacts", () => {
  let fixture: string;
  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture, "state"));
    mocks.install.mockReset();
    mocks.audit.mockReset();
    mocks.parsed = {};
    mocks.install.mockResolvedValue({ plugin: { id: "artifact-demo" } });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  async function pack(packageFields: Record<string, unknown> = {}) {
    const pkgDir = path.join(fixture, "package");
    await fs.mkdir(path.join(pkgDir, "dist", "control-ui"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "artifact-demo",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./dist/index.js"] },
        ...packageFields,
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "artifact-demo",
        name: "Artifact demo",
        version: "1.0.0",
        configSchema: { type: "object", properties: {} },
        controlUi: { entry: "dist/control-ui/index.js" },
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "index.js"),
      "export default {id:'artifact-demo',register(){}};\n",
    );
    await fs.writeFile(
      path.join(pkgDir, "dist", "control-ui", "index.js"),
      "export default {id:'artifact-demo',activate(){}};\n",
    );
    const archivePath = await packToArchive({ pkgDir, outDir: fixture, outName: "artifact.tgz" });
    const bytes = await fs.readFile(archivePath);
    return {
      kind: "plugin-activate-artifact" as const,
      path: archivePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  it("retains reviewed bytes and installs them after the task source changes", async () => {
    const operation = await pack();
    const reviewedBytes = await fs.readFile(operation.path);
    const review = await prepareSystemAgentPluginArtifact(operation);
    expect(review).toMatchObject({
      pluginId: "artifact-demo",
      nativeControlUi: true,
      sha256: operation.sha256,
    });
    expect(await fs.readFile(review.retainedPath)).toEqual(reviewedBytes);
    await fs.writeFile(operation.path, "source changed after proposal");
    let authorityOpen = true;
    const beforePersistentApply = vi.fn(() => {
      if (!authorityOpen) {
        throw new Error("initiating plugin authority retired");
      }
    });
    const applyPluginRuntime = vi.fn(async () => {
      authorityOpen = false;
      return { operationId: "artifact-install", generation: 4, pluginIds: ["artifact-demo"] };
    });
    const installedPath = path.join(
      fixture,
      "state",
      "imports",
      "plugins",
      `${operation.sha256}.tgz`,
    );
    mocks.install.mockImplementation(async (params: ManagedInstallParams) => {
      assert.ok(params.request.source === "local");
      expect(params.request.path).not.toBe(review.retainedPath);
      expect(params.recordPath).toBe(installedPath);
      expect(await fs.readFile(params.request.path)).toEqual(reviewedBytes);
      expect(await fs.readFile(installedPath)).toEqual(reviewedBytes);
      expect(params.request).toEqual({
        source: "local",
        path: expect.any(String),
        mode: "update",
        acknowledgeCapabilities: { reviewToken: review.reviewToken },
      });
      assert.ok(params.beforePersistentEffect);
      assert.ok(params.beforePersistentApply);
      assert.ok(params.applyRuntime);
      await params.beforePersistentEffect();
      params.beforePersistentApply();
      return {
        plugin: { id: "artifact-demo" },
        warnings: ["fixture install warning"],
        application: await params.applyRuntime({
          config: {},
          pluginIds: ["artifact-demo"],
          reason: "install",
          assertInvokerOwned: params.beforePersistentApply,
        }),
      };
    });
    const { runtime, lines } = createSystemAgentTestRuntime();
    expect(
      await executePluginArtifactActivation(operation, runtime, {
        approved: true,
        beforePersistentApply,
        applyPluginRuntime,
      }),
    ).toMatchObject({ applied: true });
    await expect(fs.access(review.retainedPath)).rejects.toThrow();
    expect(beforePersistentApply).toHaveBeenCalledTimes(3);
    expect(applyPluginRuntime).toHaveBeenCalledExactlyOnceWith({
      config: {},
      pluginIds: ["artifact-demo"],
      reason: "install",
      assertInvokerOwned: expect.any(Function),
    });
    expect(lines.join("\n")).toContain("Artifact installed in Gateway generation 4.");
    expect(lines.join("\n")).toContain("fixture install warning");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          pluginId: "artifact-demo",
          sha256: operation.sha256,
          sourcePath: installedPath,
        }),
      }),
    );
  });

  it.each(["before", "after"] as const)(
    "preserves the approved source when installation fails %s runtime publication",
    async (publication) => {
      const operation = await pack();
      const reviewedBytes = await fs.readFile(operation.path);
      const review = await prepareSystemAgentPluginArtifact(operation);
      const failure = new Error("registry refresh failed after commit");
      const applyPluginRuntime = vi.fn(async () => ({
        operationId: "artifact-install",
        generation: 5,
        pluginIds: ["artifact-demo"],
      }));
      mocks.install.mockImplementation(async (params: ManagedInstallParams) => {
        if (publication === "after") {
          assert.ok(params.applyRuntime);
          await params.applyRuntime({
            config: {},
            pluginIds: ["artifact-demo"],
            reason: "install",
          });
        }
        throw failure;
      });
      const { runtime, lines } = createSystemAgentTestRuntime();

      await expect(
        executePluginArtifactActivation(operation, runtime, { approved: true, applyPluginRuntime }),
      ).rejects.toBe(failure);
      const installCall = mocks.install.mock.calls[0];
      assert.ok(installCall, "The managed installer must receive the approved archive.");
      const installedPath = installCall[0].recordPath;
      expect(await fs.readFile(installedPath)).toEqual(reviewedBytes);
      await expect(fs.access(review.retainedPath)).rejects.toThrow();
      expect(lines.join("\n")).toContain("propose the exact artifact again");
      expect(applyPluginRuntime).toHaveBeenCalledTimes(publication === "after" ? 1 : 0);
      if (publication === "after") {
        expect(lines.join("\n")).toContain(
          "Plugin runtime changes were applied in Gateway generation 5; artifact activation did not complete.",
        );
      } else {
        expect(lines.join("\n")).not.toContain("Gateway generation 5");
      }
      expect(mocks.audit).not.toHaveBeenCalled();

      await expect(
        executePluginArtifactActivation(operation, runtime, { approved: true }),
      ).rejects.toThrow(/no longer retained.*propose/i);
      expect(mocks.install).toHaveBeenCalledOnce();
    },
  );

  it("retains a delegated review when Gateway lifecycle application is unavailable", async () => {
    const operation = await pack();
    const review = await prepareSystemAgentPluginArtifact(operation);
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executePluginArtifactActivation(operation, runtime, {
        approved: true,
        beforePersistentApply: () => {},
      }),
    ).rejects.toThrow("Delegated artifact activation requires the Gateway plugin lifecycle");
    expect(await fs.readFile(review.retainedPath)).toEqual(await fs.readFile(operation.path));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects a changed retained archive before entering the installer", async () => {
    const operation = await pack();
    const review = await prepareSystemAgentPluginArtifact(operation);
    await fs.writeFile(review.retainedPath, "changed reviewed bytes");
    const { runtime } = createSystemAgentTestRuntime();
    await expect(
      executePluginArtifactActivation(operation, runtime, { approved: true }),
    ).rejects.toThrow("SHA256 does not match");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("bounds pending imports without removing an installed archive", async () => {
    const operation = await pack();
    const bytes = await fs.readFile(operation.path);
    await prepareSystemAgentPluginArtifact(operation);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executePluginArtifactActivation(operation, runtime, { approved: true });
    expect(lines.join("\n")).toContain("Artifact installed; saved for the next Gateway start.");
    const installCall = mocks.install.mock.calls[0];
    assert.ok(installCall, "The managed installer must receive the approved archive.");
    const installedPath = installCall[0].recordPath;
    const pendingDir = path.join(fixture, "state", "imports", "plugins", "pending");
    await fs.mkdir(pendingDir, { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}.tgz`;
      await fs.writeFile(path.join(pendingDir, name), "abandoned review");
    }

    const next = await prepareSystemAgentPluginArtifact(await pack({ version: "2.0.0" }));
    expect((await fs.readdir(pendingDir)).length).toBeLessThanOrEqual(8);
    expect(await fs.readFile(installedPath)).toEqual(bytes);
    expect(await fs.readFile(next.retainedPath)).not.toEqual(bytes);
  });

  it("prunes expired reviews and requires a fresh proposal before applying them", async () => {
    const operation = await pack();
    const review = await prepareSystemAgentPluginArtifact(operation);
    const expired = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(review.retainedPath, expired, expired);
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executePluginArtifactActivation(operation, runtime, { approved: true }),
    ).rejects.toThrow(/expired.*propose/i);
    expect(mocks.install).not.toHaveBeenCalled();

    await prepareSystemAgentPluginArtifact(await pack({ version: "2.0.0" }));
    await expect(fs.access(review.retainedPath)).rejects.toThrow();
  });

  it.each(["review", "apply"])(
    "refuses include-owned plugin config before installation at %s",
    async (phase) => {
      const operation = await pack();
      if (phase === "apply") {
        await prepareSystemAgentPluginArtifact(operation);
      }
      mocks.parsed = { plugins: { $include: "plugins.json" } };
      const { runtime } = createSystemAgentTestRuntime();
      const attempt =
        phase === "review"
          ? prepareSystemAgentPluginArtifact(operation)
          : executePluginArtifactActivation(operation, runtime, { approved: true });
      await expect(attempt).rejects.toThrow(
        "Install the reviewed archive with openclaw plugins install",
      );
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      if (phase === "review") {
        await expect(
          fs.access(
            path.join(fixture, "state", "imports", "plugins", "pending", `${operation.sha256}.tgz`),
          ),
        ).rejects.toThrow();
      }
    },
  );

  it.each([
    { dependencies: { example: "1.0.0" } },
    { optionalDependencies: { example: "1.0.0" } },
    { scripts: { install: "node postinstall.js" } },
    { peerDependencies: { example: "*" } },
  ])("rejects an artifact requiring unreviewed installation inputs: %j", async (fields) => {
    const operation = await pack(fields);
    await expect(prepareSystemAgentPluginArtifact(operation)).rejects.toThrow(
      /bundle|dependencies|scripts/,
    );
    await expect(
      fs.access(
        path.join(fixture, "state", "imports", "plugins", "pending", `${operation.sha256}.tgz`),
      ),
    ).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("rejects a source digest mismatch and linked source files before review", async () => {
    const operation = await pack();
    await expect(
      prepareSystemAgentPluginArtifact({ ...operation, sha256: "0".repeat(64) }),
    ).rejects.toThrow("SHA256 does not match");
    const linked = path.join(fixture, "linked.tgz");
    await fs.symlink(operation.path, linked);
    await expect(
      prepareSystemAgentPluginArtifact({ ...operation, path: linked }),
    ).rejects.toThrow();
    await fs.unlink(linked);
    await fs.link(operation.path, linked);
    await expect(
      prepareSystemAgentPluginArtifact({ ...operation, path: linked }),
    ).rejects.toThrow();
  });
});
