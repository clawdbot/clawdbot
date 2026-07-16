import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";

const tempDirs: string[] = [];

function createFixtureFile(contents: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nextcloud-talk-api-credentials-"));
  tempDirs.push(tempDir);
  const passwordFile = path.join(tempDir, "password");
  writeFileSync(passwordFile, contents, "utf8");
  return passwordFile;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveNextcloudTalkApiCredentials", () => {
  it("reads and trims a file-backed API password", () => {
    const fixturePath = createFixtureFile(" example\n");

    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: " admin ", apiPasswordFile: fixturePath }),
    ).toEqual({ apiUser: "admin", apiPassword: "example" });
  });

  it("does not resolve oversized API password files", () => {
    const fixturePath = createFixtureFile("x".repeat(16 * 1024 + 1));

    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: "admin", apiPasswordFile: fixturePath }),
    ).toBeUndefined();
  });

  it("keeps inline API password precedence over the file", () => {
    const fixturePath = createFixtureFile("x".repeat(16 * 1024 + 1));

    expect(
      resolveNextcloudTalkApiCredentials({
        apiUser: "admin",
        apiPassword: "example",
        apiPasswordFile: fixturePath,
      }),
    ).toEqual({ apiUser: "admin", apiPassword: "example" });
  });

  it("returns undefined for missing and empty API password files", () => {
    const missingFile = createFixtureFile("unused");
    rmSync(missingFile);
    const emptyFile = createFixtureFile(" \n");

    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: "admin", apiPasswordFile: missingFile }),
    ).toBeUndefined();
    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: "admin", apiPasswordFile: emptyFile }),
    ).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("preserves symlinked API password files", () => {
    const targetFile = createFixtureFile("example");
    const symlinkFile = path.join(path.dirname(targetFile), "password-link");
    symlinkSync(targetFile, symlinkFile);

    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: "admin", apiPasswordFile: symlinkFile }),
    ).toEqual({ apiUser: "admin", apiPassword: "example" });
  });

  it.runIf(process.platform !== "win32")("preserves hardlinked API password files", () => {
    const targetFile = createFixtureFile("example");
    const hardlinkFile = path.join(path.dirname(targetFile), "password-hardlink");
    linkSync(targetFile, hardlinkFile);

    expect(
      resolveNextcloudTalkApiCredentials({ apiUser: "admin", apiPasswordFile: hardlinkFile }),
    ).toEqual({ apiUser: "admin", apiPassword: "example" });
  });
});
