import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { prepareTelegramQaDevice } from "../../scripts/mantis/telegram-qa-device.ts";

it("prepares fresh, closed pairing state without exporting the observer private identity", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "mantis-qa-device-"));
  try {
    const identity = await prepareTelegramQaDevice(scratch);
    expect(await readdir(scratch)).toEqual(["candidate-pairing.sqlite"]);
    const databasePath = path.join(scratch, "candidate-pairing.sqlite");
    const bytes = await readFile(databasePath);
    expect(bytes.includes(Buffer.from(identity.privateKeyPem))).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(Object.values(database.prepare("PRAGMA integrity_check").get() ?? {})).toEqual(["ok"]);
      expect(
        database.prepare("SELECT count(*) AS count FROM device_pairing_paired").get()?.count,
      ).toBe(1);
      expect(
        database.prepare("SELECT count(*) AS count FROM device_pairing_pending").get()?.count,
      ).toBe(0);
      expect(database.prepare("SELECT count(*) AS count FROM device_identities").get()?.count).toBe(
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
