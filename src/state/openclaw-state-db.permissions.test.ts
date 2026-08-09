// State database permission hardening tests cover best-effort chmod on
// filesystems without POSIX permission support (Azure Files, NFS, certain
// Docker volume drivers).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The permission helper hardens via the named import `chmodSync` from node:fs.
// A namespace `vi.spyOn(fs, ...)` cannot rebind an
// already-captured named import, so we mock node:fs and route chmodSync
// (named + default) through a single controllable failure hook.
const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: 0,
  failProbe: true,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls += 1;
    const isProbe = String(target).includes(".openclaw-chmod-probe-");
    if (chmodFailHook.error && (chmodFailHook.failProbe || !isProbe)) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const fs = await import("node:fs");
const {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} = await import("./openclaw-state-db.js");

function chmodError(code: string): Error {
  const err = new Error(`${code}: chmod failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function enotsupError(): Error {
  return chmodError("ENOTSUP");
}

describe("state database permission hardening without chmod support", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = 0;
    chmodFailHook.failProbe = true;
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("opens the state database when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    chmodFailHook.error = enotsupError();

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
    // Hardening ran and failed; the failure must stay non-fatal.
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("rethrows EPERM when existing permissions are too broad", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");
    chmodFailHook.failProbe = false;

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EPERM/,
    );
  });

  it("opens when EPERM leaves existing permissions restrictive", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("EPERM");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("opens when EROFS leaves existing permissions restrictive", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("EROFS");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("rethrows EROFS when existing permissions are too broad", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EROFS");

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EROFS/,
    );
  });

  it("opens when the filesystem probe also rejects chmod with EPERM", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    fs.chmodSync(stateDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
  });

  it("rethrows unexpected chmod errors at open", () => {
    // EACCES is not in CHMOD_UNSUPPORTED_CODES: a real permission fault on a
    // POSIX filesystem must keep the credentials-adjacent hardening fatal.
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    chmodFailHook.error = chmodError("EACCES");

    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /EACCES/,
    );
  });

  it("repairs the schema when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();

    chmodFailHook.error = enotsupError();

    expect(() =>
      repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    ).not.toThrow();
  });

  it("commits write transactions when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    chmodFailHook.error = enotsupError();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    const result = runOpenClawStateWriteTransaction((database) => {
      expect(database.db.isOpen).toBe(true);
      return "committed";
    }, options);

    expect(result).toBe("committed");
  });
});
