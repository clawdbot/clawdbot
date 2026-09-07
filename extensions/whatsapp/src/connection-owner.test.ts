// Whatsapp tests cover exclusive auth-backed connection ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  acquireWhatsAppGatewayConnectionOwner,
  acquireWhatsAppStandaloneConnectionOwner,
} from "./connection-owner.js";

async function createTempParent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-owner-"));
  onTestFinished(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("WhatsApp connection owner", () => {
  it("rejects a second process-local owner until the first lease is released", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);

    const gatewayOwner = await acquireWhatsAppGatewayConnectionOwner(authDir);
    await expect(acquireWhatsAppStandaloneConnectionOwner(authDir)).rejects.toMatchObject({
      code: "whatsapp_connection_owner_busy",
      authDir,
    });

    await gatewayOwner.release();
    const standaloneOwner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    await standaloneOwner.release();
  });

  it("lets the gateway wait for a process-local standalone owner", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);

    const standaloneOwner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    const gatewayOwnerPromise = acquireWhatsAppGatewayConnectionOwner(authDir);
    await standaloneOwner.release();

    const gatewayOwner = await gatewayOwnerPromise;
    await gatewayOwner.release();
  });

  it.runIf(process.platform !== "win32")(
    "treats symlink aliases as the same process-local owner",
    async () => {
      const parent = await createTempParent();
      const authDir = path.join(parent, "auth");
      const authAlias = path.join(parent, "auth-alias");
      await fs.mkdir(authDir);
      await fs.symlink(authDir, authAlias, "dir");

      const gatewayOwner = await acquireWhatsAppGatewayConnectionOwner(authDir);
      await expect(acquireWhatsAppStandaloneConnectionOwner(authAlias)).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
        authDir: authAlias,
      });
      await gatewayOwner.release();
    },
  );

  it("recovers an unchanged lock owned by a definitely dead process", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() })}\n`,
    );

    const owner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    await owner.release();
  });

  it("cancels cross-process owner retries during shutdown", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    const abortController = new AbortController();

    const ownerPromise = acquireWhatsAppGatewayConnectionOwner(authDir, abortController.signal);
    abortController.abort(new Error("shutdown"));

    await expect(ownerPromise).rejects.toThrow("shutdown");
  });
});
