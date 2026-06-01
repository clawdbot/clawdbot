import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDiscordRuntime, type DiscordRuntime } from "../runtime.js";
import {
  buildDiscordModelPickerPreferenceKey,
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
} from "./model-picker-preferences.js";

const tempDirs: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-picker-"));
  tempDirs.push(dir);
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  setDiscordRuntime({
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests("discord", {
          ...options,
          env: options.env ?? env,
        }),
    },
  } as unknown as DiscordRuntime);
  return env;
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("discord model picker preferences", () => {
  it("records recent models in recency order without duplicates", async () => {
    const env = await createStateEnv();
    const scope = { userId: "123" };

    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4o" });
    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4.1" });
    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4o" });

    const recent = await readDiscordModelPickerRecentModels({ env, scope });
    expect(recent).toEqual(["openai/gpt-4o", "openai/gpt-4.1"]);
  });

  it("filters recent models using an allowlist", async () => {
    const env = await createStateEnv();
    const scope = { userId: "456" };

    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4o" });
    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4.1" });

    const recent = await readDiscordModelPickerRecentModels({
      env,
      scope,
      allowedModelRefs: new Set(["openai/gpt-4.1"]),
    });
    expect(recent).toEqual(["openai/gpt-4.1"]);
  });

  it("prunes older stored models beyond the recent limit", async () => {
    const env = await createStateEnv();
    const scope = { userId: "limited-user" };
    for (const modelRef of [
      "openai/model-a",
      "openai/model-b",
      "openai/model-c",
      "openai/model-d",
    ]) {
      await recordDiscordModelPickerRecentModel({ env, scope, modelRef, limit: 2 });
    }

    await expect(readDiscordModelPickerRecentModels({ env, scope, limit: 10 })).resolves.toEqual([
      "openai/model-d",
      "openai/model-c",
    ]);
    const store = createPluginStateKeyedStoreForTests<unknown>("discord", {
      namespace: "model-picker-preferences",
      maxEntries: 2_000,
      env,
    });
    expect(await store.entries()).toHaveLength(2);
  });

  it("falls back to empty recents when stored state is malformed", async () => {
    const env = await createStateEnv();
    const key = buildDiscordModelPickerPreferenceKey({ userId: "789" });
    expect(key).toBeTruthy();
    const store = createPluginStateKeyedStoreForTests<unknown>("discord", {
      namespace: "model-picker-preferences",
      maxEntries: 2_000,
      env,
    });
    await store.register(key as string, "not-an-entry");

    const recent = await readDiscordModelPickerRecentModels({
      env,
      scope: { userId: "789" },
    });
    expect(recent).toStrictEqual([]);
  });

  it("treats plugin-state failures as optional preference misses", async () => {
    const env = await createStateEnv();
    const scope = { userId: "state-failure-user" };
    setDiscordRuntime({
      state: {
        openKeyedStore: () => {
          throw new Error("state unavailable");
        },
      },
    } as unknown as DiscordRuntime);

    await expect(readDiscordModelPickerRecentModels({ env, scope })).resolves.toEqual([]);
    await expect(
      recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4.1" }),
    ).resolves.toBeUndefined();
  });

  it("ignores retired legacy JSON preferences at runtime", async () => {
    const env = await createStateEnv();
    const scope = { userId: "legacy-runtime-user" };
    const key = buildDiscordModelPickerPreferenceKey(scope);
    expect(key).toBeTruthy();
    const legacyPath = path.join(
      env.OPENCLAW_STATE_DIR as string,
      "discord",
      "model-picker-preferences.json",
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        entries: {
          [key as string]: {
            recent: ["openai/gpt-4.1"],
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    await expect(readDiscordModelPickerRecentModels({ env, scope })).resolves.toEqual([]);
  });

  it("preserves concurrent model picker selections for the same scope", async () => {
    const env = await createStateEnv();
    const scope = { userId: "concurrent-user" };

    await Promise.all([
      recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4.1" }),
      recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4o" }),
    ]);

    const recent = await readDiscordModelPickerRecentModels({ env, scope });
    expect(new Set(recent)).toEqual(new Set(["openai/gpt-4o", "openai/gpt-4.1"]));
  });

  it("keeps selections recent when the process clock is outside the Date range", async () => {
    const env = await createStateEnv();
    const scope = { userId: "invalid-clock-user" };
    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4.1" });
    await recordDiscordModelPickerRecentModel({ env, scope, modelRef: "openai/gpt-4o" });
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    try {
      await recordDiscordModelPickerRecentModel({
        env,
        scope,
        modelRef: "openai/gpt-5.5",
        limit: 2,
      });
      await recordDiscordModelPickerRecentModel({
        env,
        scope,
        modelRef: "openai/gpt-5.6",
        limit: 2,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    await expect(readDiscordModelPickerRecentModels({ env, scope, limit: 3 })).resolves.toEqual([
      "openai/gpt-5.6",
      "openai/gpt-5.5",
    ]);
  });
});
