import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_READ_RPC_ALLOWLIST, resolveBinding } from "./data-read.js";

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-data-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("workspace data binding resolver", () => {
  it("returns static values", async () => {
    await expect(resolveBinding({ source: "static", value: { ok: true } })).resolves.toEqual({
      ok: true,
    });
  });

  it("returns the client-resolution signal for rpc bindings", async () => {
    expect(DATA_READ_RPC_ALLOWLIST).toContain("sessions.list");

    await expect(resolveBinding({ source: "rpc", method: "sessions.list" })).rejects.toMatchObject({
      code: "binding_client_resolved",
    });
  });

  it("allowlists the read methods the L4 builtin data widgets bind", () => {
    // Frozen so a builtin can never reference a method the write-time schema
    // would reject. system-presence backs builtin:instances; cron.runs backs
    // builtin:activity; usage.cost backs the stat-cards + usage widget.
    for (const method of [
      "usage.cost",
      "sessions.list",
      "cron.list",
      "cron.runs",
      "system-presence",
    ]) {
      expect(DATA_READ_RPC_ALLOWLIST).toContain(method);
    }
  });

  it("reads JSON pointers and raw markdown from the workspace data jail", async () => {
    await withTempStateDir(async (stateDir) => {
      await fs.mkdir(path.join(stateDir, "workspaces", "data", "metrics"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "workspaces", "data", "metrics", "q3.json"),
        JSON.stringify({ revenue: 42, nested: { "a/b": "escaped" } }),
      );
      await fs.writeFile(path.join(stateDir, "workspaces", "data", "notes.md"), "# Notes\n");

      await expect(
        resolveBinding(
          { source: "file", path: "metrics/q3.json", pointer: "/nested/a~1b" },
          { stateDir },
        ),
      ).resolves.toBe("escaped");
      await expect(
        resolveBinding({ source: "file", path: "notes.md" }, { stateDir }),
      ).resolves.toBe("# Notes\n");
    });
  });

  it("rejects noncanonical array indices in JSON pointers", async () => {
    await withTempStateDir(async (stateDir) => {
      await fs.mkdir(path.join(stateDir, "workspaces", "data"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "workspaces", "data", "items.json"),
        JSON.stringify({ items: ["zero", "one"], lookup: { "01": "object-key" } }),
      );

      await expect(
        resolveBinding({ source: "file", path: "items.json", pointer: "/items/0" }, { stateDir }),
      ).resolves.toBe("zero");
      await expect(
        resolveBinding({ source: "file", path: "items.json", pointer: "/items/1" }, { stateDir }),
      ).resolves.toBe("one");
      await expect(
        resolveBinding({ source: "file", path: "items.json", pointer: "/lookup/01" }, { stateDir }),
      ).resolves.toBe("object-key");

      for (const segment of [
        "",
        " ",
        "00",
        "01",
        "+1",
        "-0",
        "1.0",
        "1e0",
        "0x1",
        "9007199254740993",
      ]) {
        await expect(
          resolveBinding(
            { source: "file", path: "items.json", pointer: `/items/${segment}` },
            { stateDir },
          ),
        ).rejects.toMatchObject({ code: "binding_not_found" });
      }
    });
  });

  it("rejects file traversal and oversized files with typed errors", async () => {
    await withTempStateDir(async (stateDir) => {
      await expect(
        resolveBinding({ source: "file", path: "../secrets.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });
      await expect(
        resolveBinding({ source: "file", path: "~/metrics.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });

      await fs.mkdir(path.join(stateDir, "workspaces", "data"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "workspaces", "data", "big.csv"),
        "x".repeat(1_100_000),
      );

      await expect(
        resolveBinding({ source: "file", path: "big.csv" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_too_large" });
    });
  });

  it("rejects leaf and ancestor symlinks that escape the workspace data jail", async () => {
    await withTempStateDir(async (stateDir) => {
      const dataDir = path.join(stateDir, "workspaces", "data");
      const outsideDir = path.join(stateDir, "outside");
      const outsideFile = path.join(outsideDir, "secret.json");
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(outsideDir);
      await fs.writeFile(outsideFile, JSON.stringify({ secret: true }));
      await fs.symlink(outsideFile, path.join(dataDir, "leak.json"));
      await fs.symlink(outsideDir, path.join(dataDir, "leak-dir"));

      await expect(
        resolveBinding({ source: "file", path: "leak.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });
      await expect(
        resolveBinding({ source: "file", path: "leak-dir/secret.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });
    });
  });

  it("rejects a workspace data root replaced with a symlink", async () => {
    await withTempStateDir(async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspaces");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(outsideDir, "secret.json"), JSON.stringify({ secret: true }));
      await fs.symlink(outsideDir, path.join(workspaceDir, "data"));

      await expect(
        resolveBinding({ source: "file", path: "secret.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });
    });
  });
});
