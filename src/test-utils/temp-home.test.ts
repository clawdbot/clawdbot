import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempHomeEnv } from "./temp-home.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be removed`);
}

describe("createTempHomeEnv", () => {
  it("sets home env vars and restores them on cleanup", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;

    const tempHome = await createTempHomeEnv("openclaw-temp-home-");
    expect(process.env.HOME).toBe(tempHome.home);
    expect(process.env.USERPROFILE).toBe(tempHome.home);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(tempHome.home, ".openclaw"));
    const homeStat = await fs.stat(tempHome.home);
    expect(homeStat.isDirectory()).toBe(true);

    await tempHome.restore();

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.USERPROFILE).toBe(previousUserProfile);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    await expectPathMissing(tempHome.home);
  });
});
