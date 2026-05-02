import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createdHomes: string[] = [];

async function useMockHome(homeDir: string): Promise<void> {
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      default: { ...actual, homedir: () => homeDir },
      homedir: () => homeDir,
    };
  });
}

function makeHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-home-"));
  createdHomes.push(homeDir);
  return homeDir;
}

describe("qqbot storage laziness", () => {
  afterEach(() => {
    vi.doUnmock("node:os");
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not create ~/.openclaw/qqbot from module imports or read-only probes", async () => {
    const homeDir = makeHome();
    await useMockHome(homeDir);

    const qqbotRoot = path.join(homeDir, ".openclaw", "qqbot");

    await import("../session/session-store.js");
    await import("../session/known-users.js");
    await import("../ref/store.js");
    const { loadCredentialBackup } = await import("../config/credential-backup.js");

    expect(loadCredentialBackup("default")).toBeNull();
    expect(fs.existsSync(qqbotRoot)).toBe(false);
  });

  it("creates storage when qqbot persists runtime state", async () => {
    const homeDir = makeHome();
    await useMockHome(homeDir);

    const qqbotRoot = path.join(homeDir, ".openclaw", "qqbot");
    const { saveCredentialBackup } = await import("../config/credential-backup.js");

    saveCredentialBackup("default", "123456", "secret");

    expect(fs.existsSync(path.join(qqbotRoot, "data", "credential-backup-default.json"))).toBe(
      true,
    );
  });
});
