import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  hasMeaningfulChannelConfig,
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds,
} from "./config-presence.js";

vi.mock("./plugins/bundled-ids.js", () => ({
  listBundledChannelPluginIds: () => ["matrix"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix"],
  hasBundledChannelPersistedAuthState: ({
    channelId,
    env,
  }: {
    channelId: string;
    env?: NodeJS.ProcessEnv;
  }) => channelId === "matrix" && env?.OPENCLAW_STATE_DIR?.includes("persisted-matrix"),
}));

const tempDirs: string[] = [];

function makeTempStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-config-presence-"));
  tempDirs.push(dir);
  return dir;
}

function expectPotentialConfiguredChannelCase(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expectedIds: string[];
  expectedConfigured: boolean;
}) {
  expect(listPotentialConfiguredChannelIds(params.cfg, params.env)).toEqual(params.expectedIds);
  expect(hasPotentialConfiguredChannels(params.cfg, params.env)).toBe(params.expectedConfigured);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("config presence", () => {
  it("treats enabled-only channel sections as not meaningfully configured", () => {
    expect(hasMeaningfulChannelConfig({ enabled: false })).toBe(false);
    expect(hasMeaningfulChannelConfig({ enabled: true })).toBe(false);
    expect(hasMeaningfulChannelConfig({})).toBe(false);
    expect(hasMeaningfulChannelConfig({ homeserver: "https://matrix.example.org" })).toBe(true);
  });

  it("ignores enabled-only matrix config when listing configured channels", () => {
    const env = {} as NodeJS.ProcessEnv;
    const cfg = { channels: { matrix: { enabled: false } } };

    expectPotentialConfiguredChannelCase({
      cfg,
      env,
      expectedIds: [],
      expectedConfigured: false,
    });
  });

  it("detects env-only channel config", () => {
    const env = {
      MATRIX_ACCESS_TOKEN: "token",
    } as NodeJS.ProcessEnv;

    expectPotentialConfiguredChannelCase({
      cfg: {},
      env,
      expectedIds: ["matrix"],
      expectedConfigured: true,
    });
  });

  it("detects persisted Matrix credentials without config or env", () => {
    const stateDir = makeTempStateDir().replace(
      "openclaw-channel-config-presence-",
      "persisted-matrix-",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    expectPotentialConfiguredChannelCase({
      cfg: {},
      env,
      expectedIds: ["matrix"],
      expectedConfigured: true,
    });
  });
});
