import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { prepareWorkerSsh, workerSshOptions } from "./ssh.js";

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};

describe("worker SSH preparation", () => {
  it("shares the pinned trust context while disabling only unrequested forwardings", async () => {
    const prepared = await prepareWorkerSsh({
      ssh: SSH,
      pinnedHostKey: SSH.hostKey,
      resolveIdentity: async () => ({ kind: "path", path: "/keys/worker" }),
    });
    try {
      expect(await fs.readFile(prepared.knownHostsPath, "utf8")).toBe(
        `[worker.example.test]:2202 ${HOST_KEY}\n`,
      );
      expect(workerSshOptions(prepared, { forwarding: "disabled" })).toContain(
        "ClearAllForwardings=yes",
      );
      expect(workerSshOptions(prepared, { forwarding: "explicit" })).toContain(
        "ClearAllForwardings=no",
      );
      for (const options of [
        workerSshOptions(prepared, { forwarding: "disabled" }),
        workerSshOptions(prepared, { forwarding: "explicit" }),
      ]) {
        expect(options).toContain("StrictHostKeyChecking=yes");
        expect(options).toContain("UpdateHostKeys=no");
        expect(options).toContain("ControlMaster=no");
        expect(options).toContain("ControlPath=none");
      }
    } finally {
      await prepared.dispose();
    }
  });

  it("materializes identity contents once and removes them with the shared context", async () => {
    const prepared = await prepareWorkerSsh({
      ssh: SSH,
      pinnedHostKey: SSH.hostKey,
      resolveIdentity: async () => ({
        kind: "material",
        contents: ["part", "value"].join("\\n"),
      }),
    });
    const identityPath = prepared.identityPath;

    expect(await fs.readFile(identityPath, "utf8")).toBe("part\nvalue\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o600);
    }
    await prepared.dispose();
    await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
