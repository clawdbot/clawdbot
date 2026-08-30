import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SettingsManager } from "./settings-manager.js";

const writerScript = String.raw`
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  import { join } from "node:path";

  const [moduleUrl, settingsDir, markerDir, field] = process.argv.slice(1);
  const { FileSettingsStorage } = await import(moduleUrl);
  const settingsPath = join(settingsDir, "settings.json");
  const otherEntered = join(markerDir, "theme.entered");
  const contenderSawLock = join(markerDir, "contender-saw-lock");

  if (field === "theme" && existsSync(settingsPath + ".lock")) {
    writeFileSync(contenderSawLock, "ready");
  }

  const storage = new FileSettingsStorage(settingsDir, settingsDir);
  storage.withLock("global", (current) => {
    writeFileSync(join(markerDir, field + ".entered"), "ready");
    if (field === "defaultModel") {
      const deadline = Date.now() + 5_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(otherEntered) && !existsSync(contenderSawLock)) {
        if (Date.now() >= deadline) {
          throw new Error("contending writer did not reach the settings boundary");
        }
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    const settings = current ? JSON.parse(current) : {};
    settings[field] = field === "theme" ? "dark" : "provider/model";
    return JSON.stringify(settings, null, 2);
  });
`;

const children = new Map<ChildProcess, Promise<unknown>>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  for (const child of children.keys()) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(children.values());
  children.clear();
});

function spawnWriter(settingsDir: string, markerDir: string, field: string) {
  const moduleUrl = pathToFileURL(resolve("src/agents/sessions/settings-storage.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      writerScript,
      moduleUrl,
      settingsDir,
      markerDir,
      field,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const done = waitForChildClose(child, 10_000);
  children.set(child, done);
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  return { child, done, output: () => output };
}

describe("FileSettingsStorage", () => {
  it("loads missing settings without creating their directories", () => {
    const root = tempDirs.make("openclaw-settings-read-");
    const settingsDir = join(root, "agent");

    SettingsManager.create(root, settingsDir);

    expect(existsSync(settingsDir)).toBe(false);
    expect(existsSync(join(root, ".openclaw"))).toBe(false);
  });

  it("preserves concurrent first writes from separate processes", async () => {
    const root = tempDirs.make("openclaw-settings-first-write-");
    const settingsDir = join(root, "agent");
    const markerDir = join(root, "markers");
    mkdirSync(markerDir);

    const first = spawnWriter(settingsDir, markerDir, "defaultModel");
    await waitForFile(join(markerDir, "defaultModel.entered"), 5_000);
    const contender = spawnWriter(settingsDir, markerDir, "theme");

    for (const writer of [first, contender]) {
      const result = await writer.done;
      children.delete(writer.child);
      expect(result, writer.output()).toEqual({ code: 0, signal: null });
    }

    expect(JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"))).toEqual({
      defaultModel: "provider/model",
      theme: "dark",
    });
  }, 15_000);
});
