import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/generate-native-session-catalogs.mjs", import.meta.url),
);

it("checks generated drift and removes retired local declarations without changing external ownership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-catalog-generator-"));
  try {
    const manifestPath = path.join(root, "extensions/owned/openclaw.plugin.json");
    const feedPath = path.join(root, "scripts/lib/official-external-plugin-catalog.json");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.mkdir(path.dirname(feedPath), { recursive: true });
    const catalog = { label: "Owned conversations", nodeCommands: ["owned.sessions.list"] };
    const unknown = {
      plugin: { id: "outside" },
      setup: { nativeSessionCatalog: { label: "External" } },
    };
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ id: "owned", setup: { nativeSessionCatalog: catalog } }),
    );
    await fs.writeFile(
      feedPath,
      JSON.stringify({
        entries: [
          { openclaw: { plugin: { id: "owned" }, setup: { requiresRuntime: false } } },
          { openclaw: unknown },
        ],
      }),
    );
    for (const name of ["provider", "channel"]) {
      await fs.writeFile(
        path.join(root, `scripts/lib/official-external-${name}-catalog.json`),
        '{"entries":[]}',
      );
    }
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
    expect(run().status).toBe(0);
    expect(run("--check").status).toBe(0);
    const beforeRemoval = await fs.readFile(feedPath, "utf8");
    expect(JSON.parse(beforeRemoval).entries[0].openclaw.setup.nativeSessionCatalog).toEqual(
      catalog,
    );
    await fs.writeFile(manifestPath, JSON.stringify({ id: "owned" }));
    expect(run("--check").status).toBe(1);
    expect(await fs.readFile(feedPath, "utf8")).toBe(beforeRemoval);
    expect(run().status).toBe(0);
    const feed = JSON.parse(await fs.readFile(feedPath, "utf8"));
    expect(feed.entries[0].openclaw.setup).toEqual({ requiresRuntime: false });
    expect(feed.entries[1].openclaw).toEqual(unknown);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, "scripts/lib/native-session-catalogs.json"), "utf8"),
      ),
    ).toEqual([]);
    expect(
      await fs.readFile(
        path.join(root, "apps/macos/Sources/OpenClaw/Resources/NativeSessionCatalogs.json"),
        "utf8",
      ),
    ).toBe("[]\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
