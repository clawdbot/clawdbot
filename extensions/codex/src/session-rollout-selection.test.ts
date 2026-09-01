import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexRolloutSelection } from "./session-rollout-selection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const meta = (id = "source", provider = "native-a") => ({
  type: "session_meta",
  payload: { id, model_provider: provider, dynamic_tools: [] },
});
const settings = (model: string, provider: string) => ({
  type: "event_msg",
  payload: {
    type: "thread_settings_applied",
    thread_settings: { model, model_provider_id: provider },
  },
});
const encode = (records: unknown[]) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
async function fixture(records: unknown[]) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-selection-")));
  roots.push(dir);
  const rolloutPath = path.join(dir, "rollout.jsonl");
  await fs.writeFile(rolloutPath, encode(records));
  return {
    dir,
    rolloutPath,
    read: () =>
      readCodexRolloutSelection({
        sessionsRoot: dir,
        rolloutPath,
        threadId: "source",
        assertCurrent: () => {},
      }),
  };
}

describe("bounded durable native model observation", () => {
  it("rejects invalid UTF-8 without contaminating the next independent read", async () => {
    const invalid = await fixture([meta(), settings("invalid", "native-a")]);
    await fs.appendFile(invalid.rolloutPath, Buffer.from([0xff, 10]));
    await expect(invalid.read()).rejects.toThrow();
    const valid = await fixture([meta(), settings("valid", "native-a")]);
    await expect(valid.read()).resolves.toMatchObject({
      model: "valid",
      modelProvider: "native-a",
    });
  });

  it.each([false, true])(
    "folds native settings and turn-context scalars without resetting on rollback (compressed=%s)",
    async (compressed) => {
      const f = await fixture([
        meta(),
        settings("first", "native-b"),
        { type: "turn_context", payload: { model: "latest" } },
        meta("other", "unrelated"),
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      ]);
      if (compressed) {
        await fs.writeFile(
          `${f.rolloutPath}.zst`,
          zstdCompressSync(await fs.readFile(f.rolloutPath)),
        );
        await fs.unlink(f.rolloutPath);
      }
      const before = await fs.readFile(compressed ? `${f.rolloutPath}.zst` : f.rolloutPath);
      const selected = await f.read();
      expect(selected).toMatchObject({ model: "latest", modelProvider: "native-b" });
      await selected.assertUnchanged();
      expect(await fs.readFile(compressed ? `${f.rolloutPath}.zst` : f.rolloutPath)).toEqual(
        before,
      );
    },
  );

  it("prefers the exact plain file and rejects later replacement or growth", async () => {
    const f = await fixture([meta(), settings("plain", "native-a")]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta(), settings("compressed", "native-b")])),
    );
    const selected = await f.read();
    expect(selected.model).toBe("plain");
    await fs.appendFile(f.rolloutPath, encode([settings("new", "native-a")]));
    await expect(selected.assertUnchanged()).rejects.toThrow(/changed/);
    const current = await f.read();
    await fs.rename(f.rolloutPath, `${f.rolloutPath}.old`);
    await fs.copyFile(`${f.rolloutPath}.old`, f.rolloutPath);
    await expect(current.assertUnchanged()).rejects.toThrow(/changed/);
  });

  it.each([
    "wrong identity",
    "missing model",
    "incomplete tail",
    "oversized scalar",
    "scan budget",
    "malformed tail",
    "hardlink",
    "symlink",
  ])("fails closed for %s without selecting a fallback", async (fault) => {
    const f = await fixture([meta(), settings("selected", "native-a")]);
    await fs.writeFile(
      `${f.rolloutPath}.zst`,
      zstdCompressSync(encode([meta(), settings("fallback", "native-a")])),
    );
    if (fault === "wrong identity") {
      await fs.writeFile(f.rolloutPath, encode([meta("wrong"), settings("selected", "native-a")]));
    }
    if (fault === "missing model") {
      await fs.writeFile(f.rolloutPath, encode([meta()]));
    }
    if (fault === "incomplete tail") {
      await fs.appendFile(f.rolloutPath, '{"type":');
    }
    if (fault === "oversized scalar") {
      await fs.appendFile(f.rolloutPath, encode([settings("x".repeat(257), "native-a")]));
    }
    if (fault === "malformed tail") {
      await fs.appendFile(f.rolloutPath, "{bad}\n");
    }
    if (fault === "scan budget") {
      const ignored = encode([
        { type: "response_item", payload: { text: "x".repeat(512 * 1024) } },
      ]);
      for (let index = 0; index < 17; index++) {
        await fs.appendFile(f.rolloutPath, ignored);
      }
    }
    if (fault === "hardlink") {
      await fs.link(f.rolloutPath, `${f.rolloutPath}.link`);
    }
    if (fault === "symlink") {
      await fs.rename(f.rolloutPath, `${f.rolloutPath}.real`);
      await fs.symlink(`${f.rolloutPath}.real`, f.rolloutPath);
    }
    await expect(f.read()).rejects.toThrow();
  });
});
