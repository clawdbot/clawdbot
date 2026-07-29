// Covers config IO permission-denied errors and recovery messaging.
import fsNode from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO, resetConfigRuntimeState, writeConfigFile } from "./io.js";
import type { ConfigWriteOptions } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function makeEaccesFs(configPath: string) {
  const eaccesErr = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  return {
    existsSync: (p: string) => p === configPath,
    readFileSync: (p: string): string => {
      if (p === configPath) {
        throw eaccesErr;
      }
      throw new Error(`unexpected readFileSync: ${p}`);
    },
    promises: {
      readFile: () => Promise.reject(eaccesErr),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      appendFile: () => Promise.resolve(),
    },
  } as unknown as typeof import("node:fs");
}

describe("config io EACCES handling", () => {
  it("returns a helpful error message when config file is not readable (EACCES)", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const errors: string[] = [];
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: {
        error: (msg: unknown) => errors.push(String(msg)),
        warn: () => {},
      },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toHaveLength(1);
    expect(
      expectDefined(snapshot.issues[0], "snapshot.issues[0] test invariant").message,
    ).toContain("EACCES");
    expect(
      expectDefined(snapshot.issues[0], "snapshot.issues[0] test invariant").message,
    ).toContain("chown");
    expect(
      expectDefined(snapshot.issues[0], "snapshot.issues[0] test invariant").message,
    ).toContain(configPath);
    expect(errors.join("\n")).toContain("chown");
  });

  it("includes configPath in the chown hint for the correct remediation command", async () => {
    const configPath = "/home/myuser/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(
      expectDefined(snapshot.issues[0], "snapshot.issues[0] test invariant").message,
    ).toContain(configPath);
    expect(
      expectDefined(snapshot.issues[0], "snapshot.issues[0] test invariant").message,
    ).toContain("container");
  });

  it("marks the snapshot with the underlying read error code", async () => {
    const configPath = "/data/.openclaw/openclaw.json";
    const io = createConfigIO({
      configPath,
      fs: makeEaccesFs(configPath),
      logger: { error: () => {}, warn: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.readError).toEqual({ code: "EACCES" });
  });
});

function makeUnreadableConfigFs(configPath: string): typeof fsNode {
  const eacces = Object.assign(new Error(`EACCES: permission denied, open '${configPath}'`), {
    code: "EACCES",
  });
  const readFileSync = ((target: fsNode.PathOrFileDescriptor, options?: unknown) => {
    if (target === configPath) {
      throw eacces;
    }
    return fsNode.readFileSync(target, options as never);
  }) as typeof fsNode.readFileSync;
  const readFile = ((target: unknown, options?: unknown) => {
    if (target === configPath) {
      return Promise.reject(eacces);
    }
    return fsNode.promises.readFile(target as never, options as never);
  }) as typeof fsNode.promises.readFile;
  return {
    ...fsNode,
    readFileSync,
    promises: { ...fsNode.promises, readFile },
  } as typeof fsNode;
}

describe("config write guard after unreadable config", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fsNode.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it.each([
    { label: "default write" },
    { label: "update doctor size-drop write", writeOptions: { allowConfigSizeDrop: true } },
  ] satisfies Array<{ label: string; writeOptions?: ConfigWriteOptions }>)(
    "refuses to overwrite a present-but-unreadable config during $label",
    async ({ writeOptions }) => {
      const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
      tempRoots.push(home);
      const stateDir = path.join(home, ".openclaw");
      fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const configPath = path.join(stateDir, "openclaw.json");
      const liveConfig = {
        gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
        channels: { telegram: { enabled: true } },
        agents: { list: [{ id: "main" }] },
        meta: { lastTouchedVersion: "2026.5.3-1" },
      };
      const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
      fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });

      const io = createConfigIO({
        configPath,
        fs: makeUnreadableConfigFs(configPath),
        homedir: () => home,
        env: {},
        observe: false,
        logger: { error: () => {}, warn: () => {} },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.readError).toEqual({ code: "EACCES" });

      const skeletal: OpenClawConfig = { channels: { telegram: { enabled: true } } };
      await expect(io.writeConfigFile(skeletal, writeOptions)).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: expect.arrayContaining(["unreadable-config-before-write"]),
      });
      expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
      const rejectedArtifacts = fsNode
        .readdirSync(stateDir)
        .filter((name) => name.startsWith("openclaw.json.rejected."));
      expect(rejectedArtifacts).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects exported writes before re-reading an unreadable base snapshot",
    async () => {
      const home = fsNode.mkdtempSync(path.join(os.tmpdir(), "openclaw-unreadable-"));
      tempRoots.push(home);
      const stateDir = path.join(home, ".openclaw");
      fsNode.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const configPath = path.join(stateDir, "openclaw.json");
      const liveConfig = {
        gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
        meta: { lastTouchedVersion: "2026.5.3-1" },
      } satisfies OpenClawConfig;
      const liveBytes = `${JSON.stringify(liveConfig, null, 2)}\n`;
      fsNode.writeFileSync(configPath, liveBytes, { mode: 0o600 });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        fsNode.chmodSync(configPath, 0o000);
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
          async () => {
            await expect(
              writeConfigFile({ channels: { telegram: { enabled: true } } }),
            ).rejects.toMatchObject({
              code: "CONFIG_WRITE_REJECTED",
              reasons: expect.arrayContaining(["unreadable-config-before-write"]),
            });
          },
        );
      } finally {
        resetConfigRuntimeState();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        fsNode.chmodSync(configPath, 0o600);
      }

      expect(fsNode.readFileSync(configPath, "utf-8")).toBe(liveBytes);
      const rejectedArtifacts = fsNode
        .readdirSync(stateDir)
        .filter((name) => name.startsWith("openclaw.json.rejected."));
      expect(rejectedArtifacts).toHaveLength(1);
    },
  );
});
