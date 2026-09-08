import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareAndSwapUpdateLedger,
  parseUpdateLedgerLocator,
  readUpdateLedger,
  readUpdateLedgerReceipt,
  resolveUpdateLedgerLocator,
  type UpdateLedgerLocator,
} from "./update-ledger-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function fixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-update-ledger-${name}-`));
  tempDirs.push(root);
  const installRoot = path.join(root, "global", "openclaw");
  await fs.mkdir(installRoot, { recursive: true });
  const databaseDirectory = path.join(root, "custom-control");
  await fs.mkdir(databaseDirectory, { mode: 0o700 });
  return {
    databasePath: path.join(databaseDirectory, "transactions.sqlite"),
    installRoot,
    locator: resolveUpdateLedgerLocator({
      databasePath: path.join(databaseDirectory, "transactions.sqlite"),
      installRoot,
    }),
    root,
  };
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function runChild(params: {
  expectedRevision: number | null;
  locator: UpdateLedgerLocator;
  payloadJson: string;
  receiptId: string;
}): Promise<{ code: number; stderr: string; stdout: string }> {
  const moduleUrl = new URL("./update-ledger-store.ts", import.meta.url).href;
  const source = `
    import { compareAndSwapUpdateLedger, parseUpdateLedgerLocator } from ${JSON.stringify(moduleUrl)};
    const locator = parseUpdateLedgerLocator(JSON.parse(process.env.UPDATE_LEDGER_LOCATOR));
    const result = await compareAndSwapUpdateLedger({
      locator,
      expectedRevision: JSON.parse(process.env.EXPECTED_REVISION),
      receiptId: process.env.RECEIPT_ID,
      payloadJson: process.env.PAYLOAD_JSON,
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
      "--input-type=module",
      "--eval",
      source,
    ],
    {
      env: {
        ...process.env,
        EXPECTED_REVISION: JSON.stringify(params.expectedRevision),
        OPENCLAW_PROFILE: "post-core-child-profile",
        OPENCLAW_STATE_DIR: path.join(path.dirname(params.locator.databasePath), "wrong-profile"),
        PAYLOAD_JSON: params.payloadJson,
        RECEIPT_ID: params.receiptId,
        UPDATE_LEDGER_LOCATOR: JSON.stringify(params.locator),
        VITEST: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

describe("durable update ledger store", () => {
  it("keeps a missing read side-effect free", async () => {
    const target = await fixture("missing");

    expect(await readUpdateLedger(target.locator)).toBeNull();
    await expect(fs.access(target.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a reader racing unpublished first-use schema as not yet present", async () => {
    const target = await fixture("schema-race");
    await fs.mkdir(path.dirname(target.databasePath), { recursive: true });
    const initializer = new DatabaseSync(target.databasePath);
    if (process.platform !== "win32") {
      await fs.chmod(target.databasePath, 0o600);
    }
    initializer.exec("BEGIN IMMEDIATE; CREATE TABLE not_yet_published (value TEXT) STRICT;");
    try {
      expect(await readUpdateLedger(target.locator)).toBeNull();
    } finally {
      initializer.exec("ROLLBACK");
      initializer.close();
    }
  });

  it("admits one of two concurrent first writers", async () => {
    const target = await fixture("first-writers");
    const results = await Promise.all([
      runChild({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: JSON.stringify({ writer: "first" }),
        receiptId: "first-writer",
      }),
      runChild({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: JSON.stringify({ writer: "second" }),
        receiptId: "second-writer",
      }),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
    expect(
      results.map((result) => (JSON.parse(result.stdout) as { status: string }).status).toSorted(),
    ).toEqual(["conflict", "stored"]);
  });

  it("lets a post-core child recover an abandoned record at the transferred custom path", async () => {
    const target = await fixture("post-core");
    const pending = JSON.stringify({ phase: "pending", transactionId: "txn-1" });
    const recovered = JSON.stringify({ phase: "failed", transactionId: "txn-1" });
    expect(
      await compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: pending,
        receiptId: "begin-txn-1",
      }),
    ).toMatchObject({ status: "stored", snapshot: { revision: 1 } });
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(target.databasePath))).mode & 0o777).toBe(0o700);
    }

    const child = await runChild({
      expectedRevision: 1,
      locator: target.locator,
      payloadJson: recovered,
      receiptId: "recover-txn-1",
    });

    expect(child).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: "stored",
      snapshot: { payloadJson: recovered, receiptId: "recover-txn-1", revision: 2 },
    });
    expect(await readUpdateLedger(target.locator)).toEqual({
      payloadJson: recovered,
      receiptId: "recover-txn-1",
      revision: 2,
    });
    expect(
      await compareAndSwapUpdateLedger({
        expectedRevision: 1,
        locator: target.locator,
        payloadJson: JSON.stringify({ phase: "completed", transactionId: "txn-1" }),
        receiptId: "late-original-writer",
      }),
    ).toMatchObject({ status: "conflict", snapshot: { revision: 2 } });
    await expect(
      fs.access(path.join(path.dirname(target.databasePath), "wrong-profile")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "recovers a hot rollback journal before reading after a crashed writer",
    async () => {
      const target = await fixture("hot-journal");
      const originalPayload = JSON.stringify({ phase: "pending" });
      await compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: originalPayload,
        receiptId: "before-crash",
      });
      const ready = path.join(target.root, "writer-ready");
      const source = `
        const { DatabaseSync } = require("node:sqlite");
        const fs = require("node:fs");
        const db = new DatabaseSync(process.env.DATABASE_PATH);
        db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE");
        db.prepare("UPDATE update_ledger_heads SET payload_json = ? WHERE install_root = ?")
          .run(JSON.stringify({phase:"uncommitted",padding:"x".repeat(900000)}), process.env.INSTALL_ROOT);
        fs.writeFileSync(process.env.READY_PATH, "ready");
        setInterval(() => {}, 1000);
      `;
      const writer = spawn(process.execPath, ["--eval", source], {
        env: {
          ...process.env,
          DATABASE_PATH: target.databasePath,
          INSTALL_ROOT: target.locator.installRoot,
          READY_PATH: ready,
        },
        stdio: "ignore",
      });
      try {
        await waitForPath(ready);
        await fs.access(`${target.databasePath}-journal`);
      } finally {
        writer.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          writer.once("close", () => resolve());
        });
      }

      expect(await readUpdateLedger(target.locator)).toMatchObject({
        payloadJson: originalPayload,
        receiptId: "before-crash",
        revision: 1,
      });
      await expect(fs.access(`${target.databasePath}-journal`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("serializes by canonical install root and isolates a different global install", async () => {
    const target = await fixture("roots");
    const alias = path.join(target.root, "install-alias");
    if (process.platform !== "win32") {
      await fs.symlink(target.installRoot, alias, "dir");
      const aliasLocator = resolveUpdateLedgerLocator({
        databasePath: target.databasePath,
        installRoot: alias,
      });
      expect(aliasLocator.installRoot).toBe(target.locator.installRoot);
      await compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: aliasLocator,
        payloadJson: JSON.stringify({ profile: "a" }),
        receiptId: "profile-a",
      });
      expect(
        await compareAndSwapUpdateLedger({
          expectedRevision: null,
          locator: target.locator,
          payloadJson: JSON.stringify({ profile: "b" }),
          receiptId: "profile-b",
        }),
      ).toMatchObject({ status: "conflict", snapshot: { revision: 1 } });
    }

    const other = resolveUpdateLedgerLocator({
      databasePath: target.databasePath,
      installRoot: path.join(target.root, "other-global", "openclaw"),
    });
    expect(
      await compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: other,
        payloadJson: JSON.stringify({ profile: "other" }),
        receiptId: "other-install",
      }),
    ).toMatchObject({ status: "stored", snapshot: { revision: 1 } });
  });

  it("keeps receipt replay authoritative after the head advances", async () => {
    const target = await fixture("receipt");
    const firstPayload = JSON.stringify({ phase: "pending" });
    const first = await compareAndSwapUpdateLedger({
      expectedRevision: null,
      locator: target.locator,
      payloadJson: firstPayload,
      receiptId: "first",
    });
    await compareAndSwapUpdateLedger({
      expectedRevision: 1,
      locator: target.locator,
      payloadJson: JSON.stringify({ phase: "complete" }),
      receiptId: "second",
    });

    expect(
      await compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: firstPayload,
        receiptId: "first",
      }),
    ).toEqual({ status: "replayed", snapshot: first.snapshot });
    expect(await readUpdateLedgerReceipt({ locator: target.locator, receiptId: "first" })).toEqual(
      first.snapshot,
    );
    await expect(
      compareAndSwapUpdateLedger({
        expectedRevision: 2,
        locator: target.locator,
        payloadJson: firstPayload,
        receiptId: "first",
      }),
    ).rejects.toThrow("replayed with different content");
  });

  it("rejects unsafe transferred locators and future schemas", async () => {
    const target = await fixture("validation");
    expect(() =>
      parseUpdateLedgerLocator({ databasePath: "relative.db", installRoot: "/root" }),
    ).toThrow("database path must be an absolute path");
    const future = new DatabaseSync(target.databasePath);
    future.exec("PRAGMA user_version = 2");
    future.close();
    if (process.platform !== "win32") {
      await fs.chmod(target.databasePath, 0o600);
    }

    await expect(
      compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: JSON.stringify({ phase: "pending" }),
        receiptId: "future",
      }),
    ).rejects.toThrow("Unsupported update ledger schema");
    if (process.platform !== "win32") {
      expect((await fs.stat(target.databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not claim an unrelated private version-zero database", async () => {
    const target = await fixture("unrelated-database");
    const unrelated = new DatabaseSync(target.databasePath);
    unrelated.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('kept')");
    unrelated.close();
    if (process.platform !== "win32") {
      await fs.chmod(target.databasePath, 0o600);
    }

    await expect(
      compareAndSwapUpdateLedger({
        expectedRevision: null,
        locator: target.locator,
        payloadJson: JSON.stringify({ phase: "pending" }),
        receiptId: "must-not-claim",
      }),
    ).rejects.toThrow("nonempty database");

    const preserved = new DatabaseSync(target.databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT value FROM unrelated").get()).toEqual({ value: "kept" });
      expect(
        (preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(0);
    } finally {
      preserved.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not change permissions on an existing custom-path parent",
    async () => {
      const target = await fixture("shared-parent");
      const sharedParent = path.join(target.root, "shared-parent");
      await fs.mkdir(sharedParent, { mode: 0o755 });
      const locator = resolveUpdateLedgerLocator({
        databasePath: path.join(sharedParent, "ledger.sqlite"),
        installRoot: target.installRoot,
      });

      await expect(
        compareAndSwapUpdateLedger({
          expectedRevision: null,
          locator,
          payloadJson: JSON.stringify({ phase: "pending" }),
          receiptId: "shared-parent",
        }),
      ).rejects.toThrow("directory must be private and owned by the current user");
      expect((await fs.stat(sharedParent)).mode & 0o777).toBe(0o755);
      await expect(fs.access(locator.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a private leaf beneath a group-writable non-sticky ancestor",
    async () => {
      const target = await fixture("unsafe-ancestor");
      const unsafeAncestor = path.join(target.root, "unsafe-ancestor");
      const privateLeaf = path.join(unsafeAncestor, "private-leaf");
      await fs.mkdir(privateLeaf, { recursive: true, mode: 0o700 });
      await fs.chmod(unsafeAncestor, 0o770);
      const locator = resolveUpdateLedgerLocator({
        databasePath: path.join(privateLeaf, "ledger.sqlite"),
        installRoot: target.installRoot,
      });

      await expect(
        compareAndSwapUpdateLedger({
          expectedRevision: null,
          locator,
          payloadJson: JSON.stringify({ phase: "pending" }),
          receiptId: "unsafe-ancestor",
        }),
      ).rejects.toThrow("ancestry is not owner-controlled");
      await expect(fs.access(locator.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "makes an intermediate database-path symlink explicit before creating through it",
    async () => {
      const target = await fixture("intermediate-link");
      const destination = path.join(target.root, "redirected");
      const link = path.join(target.root, "link");
      await fs.mkdir(path.join(destination, "nested"), { recursive: true, mode: 0o700 });
      await fs.symlink(destination, link, "dir");

      const locator = resolveUpdateLedgerLocator({
        databasePath: path.join(link, "nested", "ledger.sqlite"),
        installRoot: target.installRoot,
      });
      expect(locator.databasePath).toBe(path.join(destination, "nested", "ledger.sqlite"));
      expect(
        await compareAndSwapUpdateLedger({
          expectedRevision: null,
          locator,
          payloadJson: JSON.stringify({ phase: "pending" }),
          receiptId: "redirected",
        }),
      ).toMatchObject({ status: "stored" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a final database symlink before opening it",
    async () => {
      const target = await fixture("final-link");
      const destination = path.join(path.dirname(target.databasePath), "destination.sqlite");
      const database = new DatabaseSync(destination);
      database.close();
      await fs.chmod(destination, 0o600);
      await fs.symlink(destination, target.databasePath);

      await expect(
        compareAndSwapUpdateLedger({
          expectedRevision: null,
          locator: target.locator,
          payloadJson: JSON.stringify({ phase: "pending" }),
          receiptId: "final-link",
        }),
      ).rejects.toThrow("path must be a regular file");
    },
  );
});
