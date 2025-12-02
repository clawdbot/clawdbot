import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("web logout", () => {
  const origHomedir = os.homedir;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "warelay-logout-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
    // restore for safety
    // eslint-disable-next-line @typescript-eslint/unbound-method
    (os.homedir as unknown as typeof origHomedir) = origHomedir;
  });

  it("deletes cached credentials when present", async () => {
    const credsDir = path.join(tmpDir, ".warelay", "credentials");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(path.join(credsDir, "creds.json"), "{}");
    const sessionsPath = path.join(tmpDir, ".warelay", "sessions.json");
    fs.writeFileSync(sessionsPath, "{}");
    const { logoutWeb, WA_WEB_AUTH_DIR } = await import("./session.js");

    expect(WA_WEB_AUTH_DIR.startsWith(tmpDir)).toBe(true);
    const result = await logoutWeb(runtime as never);

    expect(result).toBe(true);
    expect(fs.existsSync(credsDir)).toBe(false);
    expect(fs.existsSync(sessionsPath)).toBe(false);
  });

  it("no-ops when nothing to delete", async () => {
    const { logoutWeb } = await import("./session.js");
    const result = await logoutWeb(runtime as never);
    expect(result).toBe(false);
    expect(runtime.log).toHaveBeenCalled();
  });
});
