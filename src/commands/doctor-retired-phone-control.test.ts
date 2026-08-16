// Doctor tests cover retirement of the Phone Control lease config and journal.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import {
  finalizeRetiredPhoneControlCleanup,
  prepareRetiredPhoneControlCleanup,
} from "./doctor-retired-phone-control.js";

const RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
  "health.summary",
] as const;

function createV3State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    generation: "generation-1",
    phase: "active",
    armedAtMs: 1,
    expiresAtMs: 2,
    group: "writes",
    armedCommands: ["sms.send"],
    addedToAllow: [],
    removedFromDeny: [],
    persistentAllows: [],
    ...overrides,
  };
}

describe("retired Phone Control doctor migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-phone-control-retire-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("removes journal-owned allows and the exact setup deny seed", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register(
      "generation-1",
      createV3State({
        addedToAllow: ["sms.send"],
        removedFromDeny: ["sms.send"],
      }),
    );
    const cfg = {
      gateway: {
        nodes: {
          commands: {
            allow: ["sms.send", "custom.command"],
            deny: RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS.filter(
              (command) => command !== "sms.send",
            ),
          },
        },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands?.allow).toEqual(["custom.command"]);
    expect(result.config.gateway?.nodes?.commands?.deny).toBeUndefined();
    expect(result.cleanupPending).toBe(true);
    expect(result.configChanges).toHaveLength(2);
  });

  it("does not expose an allow that was effective only because a lease removed the seed deny", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register(
      "generation-1",
      createV3State({
        addedToAllow: [],
        removedFromDeny: ["sms.send"],
        persistentAllows: [],
      }),
    );
    const cfg = {
      gateway: {
        nodes: {
          commands: {
            allow: ["sms.send"],
            deny: RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS.filter(
              (command) => command !== "sms.send",
            ),
          },
        },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands).toBeUndefined();
    expect(result.configChanges).toEqual([
      "Removed stale Phone Control lease-only command allow entries.",
      "Removed the retired Phone Control setup deny seed.",
    ]);
  });

  it("prefers the authoritative SQLite journal over a stale legacy source", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register(
      "generation-1",
      createV3State({
        addedToAllow: ["sms.send"],
        persistentAllows: ["health.summary"],
      }),
    );
    const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ version: 2, addedToAllow: ["health.summary"] }),
    );
    const cfg = {
      gateway: {
        nodes: { commands: { allow: ["sms.send", "health.summary"] } },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands?.allow).toEqual(["health.summary"]);
    expect(result.cleanupSafe).toBe(true);
  });

  it("removes an exact setup deny seed without creating an empty commands object", async () => {
    const cfg = {
      gateway: {
        nodes: { commands: { deny: [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS] } },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands).toBeUndefined();
    expect(result.configChanges).toEqual(["Removed the retired Phone Control setup deny seed."]);
  });

  it("keeps exact-seed entries that currently shadow explicit allows", async () => {
    const cfg = {
      gateway: {
        nodes: {
          commands: {
            allow: ["sms.send"],
            deny: [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS],
          },
        },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands).toEqual({
      allow: ["sms.send"],
      deny: ["sms.send"],
    });
    expect(result.configChanges).toEqual(["Removed the retired Phone Control setup deny seed."]);
  });

  it("leaves policy untouched when the retired lease journal is malformed", async () => {
    const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ version: 3 }));
    const cfg = {
      gateway: {
        nodes: {
          commands: {
            allow: ["sms.send"],
            deny: [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS],
          },
        },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config).toBe(cfg);
    expect(result.cleanupSafe).toBe(false);
    expect(result.configChanges).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects a malformed canonical lease journal record", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register("generation-1", { version: 3 });
    const cfg = {
      gateway: {
        nodes: { commands: { deny: [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS] } },
      },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config).toBe(cfg);
    expect(result.cleanupSafe).toBe(false);
    expect(result.cleanupPending).toBe(true);
    expect(result.warnings).toEqual([
      "Retired Phone Control lease journal contains a malformed record.",
    ]);
  });

  it("fails closed when a retired state path cannot be inspected", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const statSpy = vi.spyOn(fs, "stat").mockRejectedValueOnce(error);
    const cfg = {
      gateway: {
        nodes: { commands: { deny: [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS] } },
      },
    } as OpenClawConfig;

    try {
      const result = await prepareRetiredPhoneControlCleanup({ cfg, env });
      expect(result.config).toBe(cfg);
      expect(result.cleanupSafe).toBe(false);
      expect(result.cleanupPending).toBe(true);
      expect(result.warnings[0]).toContain("Could not inspect retired Phone Control lease state");
    } finally {
      statSpy.mockRestore();
    }
  });

  it("does not touch operator-authored command entries that differ from the old seed", async () => {
    const deny = [...RETIRED_PHONE_CONTROL_SEEDED_DENY_COMMANDS, "custom.command"];
    const cfg = {
      gateway: { nodes: { commands: { allow: ["sms.send"], deny } } },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config).toBe(cfg);
    expect(result.config.gateway?.nodes?.commands).toEqual({ allow: ["sms.send"], deny });
    expect(result.configChanges).toEqual([]);
  });

  it("restores journal-owned deny entries without removing customized operator policy", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register(
      "generation-1",
      createV3State({
        removedFromDeny: ["computer.act"],
      }),
    );
    const deny = ["camera.snap", "custom.command"];
    const cfg = {
      gateway: { nodes: { commands: { deny } } },
    } as OpenClawConfig;

    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

    expect(result.config.gateway?.nodes?.commands?.deny).toEqual([
      "camera.snap",
      "custom.command",
      "computer.act",
    ]);
    expect(result.configChanges).toEqual([
      "Restored command deny entries removed by Phone Control leases.",
    ]);
  });

  it("drops the SQLite journal and archives the legacy lease source", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register("generation-1", createV3State({ addedToAllow: ["sms.send"] }));
    const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ version: 2, addedToAllow: ["camera.snap"] }));

    const result = await finalizeRetiredPhoneControlCleanup({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    await expect(store.entries()).resolves.toEqual([]);
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await expect(fs.access(`${legacyPath}.migrated`)).resolves.toBeUndefined();
  });

  it("keeps the canonical journal when the stale legacy source cannot be archived", async () => {
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
      namespace: "armed",
      maxEntries: 1,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register("generation-1", createV3State({ addedToAllow: ["sms.send"] }));
    const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ version: 2, addedToAllow: ["camera.snap"] }));
    await fs.mkdir(`${legacyPath}.migrated`);

    const result = await finalizeRetiredPhoneControlCleanup({ env });

    expect(result.warnings).toHaveLength(1);
    await expect(store.entries()).resolves.toHaveLength(1);
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
  });
});
