import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../daemon/service.js";
import type { GatewayServiceEnvArgs } from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

function createService(overrides: Partial<GatewayService>): GatewayService {
  return createMockGatewayService({
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    ...overrides,
  });
}

function requireMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

describe("readServiceStatusSummary", () => {
  it("marks OpenClaw-managed services as installed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({ programArguments: ["openclaw", "gateway", "run"] })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(true);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("enabled");
  });

  it("marks running unmanaged services as externally managed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(false);
    expect(summary.externallyManaged).toBe(true);
    expect(summary.loadedText).toBe("running (externally managed)");
  });

  it("keeps missing services as not installed when nothing is running", async () => {
    const summary = await readServiceStatusSummary(createService({}), "Daemon");

    expect(summary.installed).toBe(false);
    expect(summary.managedByOpenClaw).toBe(false);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("disabled");
  });

  it("passes command environment to runtime and loaded checks", async () => {
    const isLoaded = vi.fn(async ({ env }: GatewayServiceEnvArgs) => {
      return env?.OPENCLAW_GATEWAY_PORT === "18789";
    });
    const readRuntime = vi.fn(async (env?: NodeJS.ProcessEnv) => ({
      status: env?.OPENCLAW_GATEWAY_PORT === "18789" ? ("running" as const) : ("unknown" as const),
    }));

    const summary = await readServiceStatusSummary(
      createService({
        isLoaded,
        readCommand: vi.fn(async () => ({
          programArguments: ["openclaw", "gateway", "run", "--port", "18789"],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        })),
        readRuntime,
      }),
      "Daemon",
    );

    const loadedArgs = requireMockArg(isLoaded, "isLoaded") as GatewayServiceEnvArgs;
    expect(loadedArgs?.env?.OPENCLAW_GATEWAY_PORT).toBe("18789");
    const runtimeEnv = requireMockArg(readRuntime, "readRuntime") as NodeJS.ProcessEnv;
    expect(runtimeEnv?.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(summary.installed).toBe(true);
    expect(summary.loaded).toBe(true);
    expect(summary.runtime?.status).toBe("running");
  });

  it("includes service layout diagnostics and flags source checkout entrypoints", async () => {
    await withTempDir({ prefix: "openclaw-status-service-layout-" }, async (root) => {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "extensions"), { recursive: true });
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
        "utf8",
      );
      const entrypoint = path.join(root, "dist", "index.js");
      const serviceFile = path.join(root, "openclaw-gateway.service");
      await fs.writeFile(entrypoint, "export {};\n", "utf8");
      await fs.writeFile(serviceFile, "[Service]\n", "utf8");
      const realRoot = await fs.realpath(root);

      const summary = await readServiceStatusSummary(
        createService({
          isLoaded: vi.fn(async () => true),
          readCommand: vi.fn(async () => ({
            programArguments: ["/usr/bin/node", entrypoint, "gateway", "run"],
            sourcePath: serviceFile,
          })),
          readRuntime: vi.fn(async () => ({ status: "running" })),
        }),
        "Daemon",
      );

      const layout = summary.layout;
      if (!layout) {
        throw new Error("Expected service layout diagnostics");
      }
      expect(layout.sourcePath).toBe(serviceFile);
      expect(layout.sourcePathReal).toBe(path.join(realRoot, "openclaw-gateway.service"));
      expect(layout.entrypoint).toBe(entrypoint);
      expect(layout.entrypointReal).toBe(path.join(realRoot, "dist", "index.js"));
      expect(layout.packageRoot).toBe(realRoot);
      expect(layout.packageRootReal).toBe(realRoot);
      expect(layout.packageVersion).toBe("0.0.0-test");
      expect(layout.entrypointSourceCheckout).toBe(true);
      expect(layout.execStart).toBe(`/usr/bin/node ${entrypoint} gateway run`);
    });
  });
});
