import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a Control UI mock test port");
  }
  return address.port;
}

async function startMockServer(port: number, titleFile: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--title-file",
      titleFile,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting Control UI mock server: ${stderr}`));
    }, 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const match = chunk.match(/\[control-ui-mock\] (http:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Control UI mock server exited (${code ?? signal}): ${stderr}`));
    });
  });
}

afterEach(async () => {
  const exits = Array.from(children, async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
    }
  });
  await Promise.all(exits);
  children.clear();
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("Control UI mock title endpoint", () => {
  it("reads the title file again for every request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openclaw-mock-title-"));
    temporaryDirectories.add(directory);
    const titleFile = path.join(directory, "title.txt");
    await writeFile(titleFile, "First mock title\n", "utf8");
    const serverUrl = await startMockServer(await reservePort(), titleFile);
    const endpoint = new URL("/__mock/title", serverUrl);

    const first = await fetch(endpoint);
    expect(first.headers.get("cache-control")).toBe("no-store");
    await expect(first.text()).resolves.toBe("First mock title");

    await writeFile(titleFile, "Second mock title\n", "utf8");
    const second = await fetch(endpoint);
    expect(second.headers.get("cache-control")).toBe("no-store");
    await expect(second.text()).resolves.toBe("Second mock title");
  }, 30_000);
});
