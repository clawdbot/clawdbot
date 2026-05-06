import fs from "node:fs";
import path from "node:path";
import type { createJiti as createJitiType } from "jiti";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

const jitiFactoryOverrideKey = Symbol.for("openclaw.channelConfigSurfaceJitiFactoryOverride");

function stubChannelConfigSurfaceJitiFactory(createJiti: typeof createJitiType): void {
  (
    globalThis as typeof globalThis & {
      [jitiFactoryOverrideKey]?: typeof createJitiType;
    }
  )[jitiFactoryOverrideKey] = createJiti;
}

afterEach(() => {
  delete (
    globalThis as typeof globalThis & {
      [jitiFactoryOverrideKey]?: typeof createJitiType;
    }
  )[jitiFactoryOverrideKey];
});

async function importLoaderWithMissingBun() {
  const spawnSync = vi.fn(() => ({
    error: Object.assign(new Error("bun not found"), { code: "ENOENT" }),
    status: null,
    stdout: "",
    stderr: "",
  }));
  vi.doMock("node:child_process", () => ({ spawnSync }));

  try {
    const imported = await importFreshModule<
      typeof import("../../scripts/load-channel-config-surface.ts")
    >(import.meta.url, "../../scripts/load-channel-config-surface.ts?scope=missing-bun");
    return { loadChannelConfigSurfaceModule: imported.loadChannelConfigSurfaceModule, spawnSync };
  } finally {
    vi.doUnmock("node:child_process");
  }
}

async function importLoaderWithFailingJitiAndWorkingBun() {
  const spawnSync = vi.fn(() => ({
    error: undefined,
    status: 0,
    stdout: JSON.stringify({
      schema: {
        type: "object",
        properties: {
          ok: { type: "number" },
        },
      },
    }),
    stderr: "",
  }));
  const createJiti = vi.fn(() => () => {
    throw new Error("jiti failed");
  });
  vi.doMock("node:child_process", () => ({ spawnSync }));
  stubChannelConfigSurfaceJitiFactory(createJiti as unknown as typeof createJitiType);

  try {
    const imported = await importFreshModule<
      typeof import("../../scripts/load-channel-config-surface.ts")
    >(import.meta.url, "../../scripts/load-channel-config-surface.ts?scope=failing-jiti");
    return {
      loadChannelConfigSurfaceModule: imported.loadChannelConfigSurfaceModule,
      spawnSync,
      createJiti,
    };
  } finally {
    vi.doUnmock("node:child_process");
  }
}

function expectedOkSchema(type: string) {
  return {
    schema: {
      type: "object",
      properties: {
        ok: { type },
      },
    },
  };
}

function createDemoConfigSchemaModule(repoRoot: string, sourceLines?: string[]) {
  const packageRoot = path.join(repoRoot, "extensions", "demo");
  const modulePath = path.join(packageRoot, "src", "config-schema.js");

  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@openclaw/demo", type: "module" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    modulePath,
    [
      ...(sourceLines ?? [
        "export const DemoChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { ok: { type: 'string' } },",
        "  },",
        "};",
      ]),
      "",
    ].join("\n"),
    "utf8",
  );

  return { packageRoot, modulePath };
}

describe("loadChannelConfigSurfaceModule", () => {
  it("prefers the source-aware loader over bun when both succeed", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const { modulePath } = createDemoConfigSchemaModule(repoRoot);

      const spawnSync = vi.fn(() => ({
        error: undefined,
        status: 0,
        stdout: JSON.stringify({
          schema: {
            type: "object",
            properties: {
              ok: { type: "number" },
            },
          },
        }),
        stderr: "",
      }));
      vi.doMock("node:child_process", () => ({ spawnSync }));

      try {
        const imported = await importFreshModule<
          typeof import("../../scripts/load-channel-config-surface.ts")
        >(import.meta.url, "../../scripts/load-channel-config-surface.ts?scope=prefer-jiti");

        await expect(
          imported.loadChannelConfigSurfaceModule(modulePath, { repoRoot }),
        ).resolves.toMatchObject(expectedOkSchema("string"));
        expect(spawnSync).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock("node:child_process");
      }
    });
  });

  it("does not require bun when the source-aware loader succeeds", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const { modulePath } = createDemoConfigSchemaModule(repoRoot);

      const { loadChannelConfigSurfaceModule: loadWithMissingBun, spawnSync } =
        await importLoaderWithMissingBun();

      await expect(loadWithMissingBun(modulePath, { repoRoot })).resolves.toMatchObject(
        expectedOkSchema("string"),
      );
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  it("falls back to bun when the source-aware loader fails", async () => {
    await withTempDir({ prefix: "openclaw-config-surface-" }, async (repoRoot) => {
      const { modulePath } = createDemoConfigSchemaModule(repoRoot, ["export const = ;"]);

      const { loadChannelConfigSurfaceModule: loadWithFailingJiti, spawnSync } =
        await importLoaderWithFailingJitiAndWorkingBun();

      await expect(loadWithFailingJiti(modulePath, { repoRoot })).resolves.toMatchObject(
        expectedOkSchema("number"),
      );
      expect(spawnSync).toHaveBeenCalledWith("bun", expect.any(Array), expect.any(Object));
    });
  });
});
