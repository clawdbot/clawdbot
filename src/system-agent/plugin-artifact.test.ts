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
vi.mock("../cli/plugins-install-config.js", () => ({
  loadConfigForInstall: async () => ({ config: {}, baseHash: "config", writeOptions: {} }),
}));
vi.mock("../plugins/management-service.js", () => ({ installManagedPluginSource: mocks.install }));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, run: () => Promise<unknown>) => await run(),
}));

describe("exact system-agent plugin artifacts", () => {
  let fixture: string;
  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture, "state"));
    mocks.install.mockReset();
    mocks.audit.mockReset();
    mocks.parsed = {};
    mocks.install.mockResolvedValue({ ok: true, pluginId: "artifact-demo", config: {} });
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
    const beforePersistentApply = vi.fn(async () => {});
    mocks.install.mockImplementation(async (params) => {
      expect(params.request.path).not.toBe(review.retainedPath);
      expect(params.request.recordPath).toBe(review.retainedPath);
      expect(await fs.readFile(params.request.path)).toEqual(reviewedBytes);
      expect(params.acknowledgeCapabilities).toEqual({ reviewToken: review.reviewToken });
      await params.beforePersistentEffect();
      return { ok: true, pluginId: "artifact-demo", config: {} };
    });
    const { runtime, lines } = createSystemAgentTestRuntime();
    expect(
      await executePluginArtifactActivation(operation, runtime, {
        approved: true,
        beforePersistentApply,
      }),
    ).toMatchObject({ applied: true });
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain("Restart the Gateway");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ pluginId: "artifact-demo", sha256: operation.sha256 }),
      }),
    );
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
          fs.access(path.join(fixture, "state", "imports", "plugins", `${operation.sha256}.tgz`)),
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
      fs.access(path.join(fixture, "state", "imports", "plugins", `${operation.sha256}.tgz`)),
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
