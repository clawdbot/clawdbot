import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// auth-storage.ts persists via the named import `writeFileSync` from node:fs,
// and replaceFileAtomicSync (in @openclaw/fs-safe) writes its temp file via the
// default import `syncFs.writeFileSync`. A namespace `vi.spyOn(fs, ...)` cannot
// rebind an already-captured named import, so we mock node:fs and route every
// writeFileSync (named + default) through a single controllable write-failure hook.
const writeFailHook = vi.hoisted(() => ({
  fn: undefined as ((file: unknown, data: unknown, options: unknown) => void) | undefined,
  // The unwrapped writeFileSync, so the hook can mutate disk state
  // (e.g. truncate the destination) without re-entering itself.
  raw: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  writeFailHook.raw = actual.writeFileSync as (...args: unknown[]) => unknown;
  const writeFileSync: typeof actual.writeFileSync = ((
    file: unknown,
    data: unknown,
    options: unknown,
  ) => {
    writeFailHook.fn?.(file, data, options);
    return (actual.writeFileSync as (...a: unknown[]) => unknown)(file, data, options);
  }) as typeof actual.writeFileSync;
  return {
    ...actual,
    writeFileSync,
    default: { ...actual, writeFileSync },
  };
});

const fs = await import("node:fs");
const { AuthStorage } = await import("./auth-storage.js");

describe("auth-storage survives an interrupted write during persist (atomic write)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    writeFailHook.fn = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("does not lock out credentials when a write fails mid-flush", async () => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), "auth-writefail-"));
    const authPath = join(tmpDir, "auth.json");

    // Seed a valid credential that round-trips cleanly.
    const seed = AuthStorage.create(authPath);
    seed.set("anthropic", { type: "api_key", key: "sk-test-SEED-12345" });
    expect(await AuthStorage.create(authPath).getApiKey("anthropic")).toBe("sk-test-SEED-12345");

    // Model a write that fails partway during the next persist (a full disk, an
    // over-quota volume, or a power loss before the flush). Only a *direct* write
    // to auth.json leaves it corrupt:
    //   - raw writeFileSync (RED): the persist writes straight to auth.json, so
    //     the OS has already O_TRUNC-opened the destination. We model the partial
    //     on-disk state by truncating auth.json, then failing the write.
    //   - replaceFileAtomicSync (GREEN): the persist writes to a sibling temp
    //     file (via fs-safe) and renames it into place. It never writes auth.json
    //     directly, so this hook never fires and the persist completes cleanly --
    //     which is exactly the write-atomicity we are asserting (auth.json is
    //     never left partial).
    writeFailHook.fn = (file) => {
      if (typeof file === "number") {
        return;
      }
      if (String(file) === authPath) {
        writeFailHook.raw?.(authPath, "", "utf-8");
        throw Object.assign(new Error("simulated write failure mid-flush"), {
          code: "ENOSPC",
        });
      }
    };

    const persisting = AuthStorage.create(authPath);
    // Raw writeFileSync targets auth.json directly, so the hook truncates it and
    // throws (RED). The atomic write targets a temp file + rename, so the hook
    // never fires and set() completes cleanly (GREEN).
    try {
      persisting.set("openai", { type: "api_key", key: "sk-test-NEW-67890" });
    } catch {
      // raw path throws after truncating auth.json; atomic path does not throw.
    }
    writeFailHook.fn = undefined;

    // Next boot: the original credential must still load.
    // RED (raw writeFileSync): auth.json is now empty -> JSON.parse throws on
    //   reload -> loadError -> getApiKey returns undefined -> lockout.
    // GREEN (replaceFileAtomicSync): auth.json was never written directly, so it
    //   holds the atomically-renamed new content (seed still present).
    const reopened = AuthStorage.create(authPath);
    expect(reopened.drainErrors()).toHaveLength(0);
    expect(await reopened.getApiKey("anthropic")).toBe("sk-test-SEED-12345");
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.readFileSync(authPath, "utf-8").length).toBeGreaterThan(0);
  });

  it("preserves existing auth directory permissions while replacing the file", () => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), "auth-dir-mode-"));
    fs.chmodSync(tmpDir, 0o755);
    const authPath = join(tmpDir, "auth.json");

    const storage = AuthStorage.create(authPath);
    storage.set("anthropic", { type: "api_key", key: "sk-test-SEED-12345" });

    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
  });
});
