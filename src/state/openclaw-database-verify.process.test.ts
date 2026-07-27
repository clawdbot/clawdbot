import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function importVerifierInUnrelatedFork(): Promise<unknown[]> {
  const fixtureDir = tempDirs.make("openclaw-database-verify-process-");
  const fixturePath = path.join(fixtureDir, "unrelated-child.mjs");
  const verifierUrl = pathToFileURL(
    path.resolve("src/state/openclaw-database-verify.worker.ts"),
  ).href;
  fs.writeFileSync(
    fixturePath,
    `
      await import(${JSON.stringify(verifierUrl)});
      process.once("message", (message) => {
        process.send?.({ echo: message }, () => process.disconnect?.());
      });
    `,
  );

  const child = fork(fixturePath, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return await new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("unrelated verifier import did not exit"));
    }, 10_000);
    child.on("message", (message: unknown) => messages.push(message));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(messages);
      } else {
        reject(new Error(`unrelated verifier import exited with ${signal ?? code}`));
      }
    });
    child.send({ type: "unrelated" });
  });
}

describe("database verifier child process entrypoint", () => {
  it("does not consume an unrelated fork's IPC messages", async () => {
    await expect(importVerifierInUnrelatedFork()).resolves.toEqual([
      { echo: { type: "unrelated" } },
    ]);
  });
});
