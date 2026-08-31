import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixQaCliE2eeSetupRuntime,
  createMatrixQaCliSelfVerificationRuntime,
} from "./scenario-runtime-e2ee-cli-runtime.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});

const fixture = vi.hoisted(() => ({ tempRoot: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => fixture.tempRoot,
}));

const constructors = [
  {
    name: "setup",
    create: (context: MatrixQaScenarioContext) =>
      createMatrixQaCliE2eeSetupRuntime({
        context,
        artifactLabel: "setup",
        initialConfig: { fixtureToken: "test-config-value" },
      }),
  },
  {
    name: "self-verification",
    create: (context: MatrixQaScenarioContext) =>
      createMatrixQaCliSelfVerificationRuntime({
        context,
        accountId: "self",
        accessToken: "test-access-token",
        deviceId: "TEST-DEVICE",
        userId: "@self:matrix-qa.test",
      }),
  },
];

describe.each(constructors)("Matrix CLI $name construction", ({ create }) => {
  let root: string;
  let outputDir: string;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
    vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-cli-construction-"));
    fixture.tempRoot = path.join(root, "temp");
    outputDir = path.join(root, "artifacts");
    await fs.mkdir(fixture.tempRoot);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await actual.rm(root, { recursive: true, force: true });
  });

  it("removes the private config root after late environment failure while preserving output artifacts", async () => {
    await expect(create(createMatrixQaE2eeTestContext({ outputDir }))).rejects.toThrow(
      "require the gateway runtime environment",
    );
    expect(await fs.readdir(fixture.tempRoot)).toEqual([]);
    expect((await fs.readdir(outputDir)).length).toBeGreaterThan(0);
  });

  it("removes its temp root on an actual filesystem setup failure", async () => {
    await fs.writeFile(outputDir, "not a directory");
    await expect(
      create(createMatrixQaE2eeTestContext({ outputDir, gatewayRuntimeEnv: {} })),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await fs.readdir(fixture.tempRoot)).toEqual([]);
    expect(await fs.readFile(outputDir, "utf8")).toBe("not a directory");
  });

  it("retains the original setup failure when removing the owned root also fails", async () => {
    const setupFailure = new Error("config write failed");
    const cleanupFailure = new Error("temp removal failed");
    vi.mocked(fs.writeFile).mockRejectedValueOnce(setupFailure);
    vi.mocked(fs.rm).mockRejectedValueOnce(cleanupFailure);
    await expect(
      create(createMatrixQaE2eeTestContext({ outputDir, gatewayRuntimeEnv: {} })),
    ).rejects.toMatchObject({ cause: setupFailure, errors: [setupFailure, cleanupFailure] });
  });

  it("keeps successful private state until disposal and preserves the artifact directory", async () => {
    const runtime = await create(
      createMatrixQaE2eeTestContext({ outputDir, gatewayRuntimeEnv: {} }),
    );
    const privateRoot = path.dirname(runtime.configPath);
    try {
      const config = JSON.parse(await fs.readFile(runtime.configPath, "utf8"));
      if ("fixtureToken" in config) {
        expect(config.fixtureToken).toBe("test-config-value");
      } else {
        expect(config.channels.matrix.accounts.self).toMatchObject({
          accessToken: "test-access-token",
          initialSyncLimit: 0,
          startupVerification: "off",
        });
      }
      if (process.platform !== "win32") {
        expect((await fs.stat(privateRoot)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(runtime.configPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await runtime.dispose();
    }
    await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(runtime.rootDir)).isDirectory()).toBe(true);
  });
});
