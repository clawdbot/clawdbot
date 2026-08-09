import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { prepareWorkerSsh, runWorkerSshCandidates, workerSshOptions } from "./ssh.js";

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  fallbackPorts: [22, 2200],
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};

function prepareTestWorkerSsh() {
  return prepareWorkerSsh({
    ssh: SSH,
    pinnedHostKey: SSH.hostKey,
    resolveIdentity: async () => ({ kind: "path" as const, path: "/keys/worker" }),
  });
}

describe("worker SSH preparation", () => {
  it("shares the pinned trust context while disabling only unrequested forwardings", async () => {
    let identityResolutions = 0;
    const prepared = await prepareWorkerSsh({
      ssh: SSH,
      pinnedHostKey: SSH.hostKey,
      resolveIdentity: async () => {
        identityResolutions += 1;
        return { kind: "path", path: "/keys/worker" };
      },
    });
    try {
      expect(await fs.readFile(prepared.knownHostsPath, "utf8")).toBe(
        [
          `[worker.example.test]:2202 ${HOST_KEY}`,
          `worker.example.test ${HOST_KEY}`,
          `[worker.example.test]:2200 ${HOST_KEY}`,
          "",
        ].join("\n"),
      );
      expect(identityResolutions).toBe(1);
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

  it("rotates stable advertised order from the selected authenticated port", async () => {
    const prepared = await prepareTestWorkerSsh();
    try {
      const attempted: number[] = [];
      await runWorkerSshCandidates(prepared, 10_000, async (port) => {
        attempted.push(port);
        return {
          stdout: "",
          stderr: "",
          code: port === 2202 ? 255 : 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });

      expect(attempted).toEqual([2202, 22]);
      expect(prepared.port).toBe(22);

      const retryOrder: number[] = [];
      await runWorkerSshCandidates(prepared, 10_000, async (port) => {
        retryOrder.push(port);
        return {
          stdout: "",
          stderr: "",
          code: 255,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      });
      expect(retryOrder).toEqual([22, 2200, 2202]);
    } finally {
      await prepared.dispose();
    }
  });

  it("shares a decreasing deadline while preserving fast fallback budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const prepared = await prepareTestWorkerSsh();
    try {
      const remainingTimeouts: number[] = [];
      const result = await runWorkerSshCandidates(
        prepared,
        1_000,
        async (port, remainingTimeoutMs) => {
          remainingTimeouts.push(remainingTimeoutMs);
          if (port === 2202) {
            vi.advanceTimersByTime(1);
            return { code: 255, termination: "exit" };
          }
          return { code: 0, termination: "exit" };
        },
      );

      expect(remainingTimeouts).toEqual([1_000, 999]);
      expect(result).toEqual({ code: 0, termination: "exit" });
      expect(prepared.port).toBe(22);
    } finally {
      await prepared.dispose();
      vi.useRealTimers();
    }
  });

  it("does not start a later candidate after the operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const prepared = await prepareTestWorkerSsh();
    try {
      const attempted: number[] = [];
      const firstResult = { code: 255, termination: "exit" as const };
      const result = await runWorkerSshCandidates(prepared, 100, async (port) => {
        attempted.push(port);
        vi.advanceTimersByTime(100);
        return firstResult;
      });

      expect(attempted).toEqual([2202]);
      expect(result).toBe(firstResult);
      expect(prepared.port).toBe(2202);
    } finally {
      await prepared.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["timeout", "signal"] as const)(
    "does not select a candidate after %s termination",
    async (termination) => {
      const prepared = await prepareTestWorkerSsh();
      prepared.selectPort(22);
      try {
        const attempted: number[] = [];
        const result = await runWorkerSshCandidates(prepared, 1_000, async (port) => {
          attempted.push(port);
          return port === 22
            ? { code: 255, termination: "exit" as const }
            : { code: null, termination };
        });

        expect(attempted).toEqual([22, 2200]);
        expect(result).toEqual({ code: null, termination });
        expect(prepared.port).toBe(22);
      } finally {
        await prepared.dispose();
      }
    },
  );

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
