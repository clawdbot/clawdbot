import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = ".agents/skills/openclaw-secret-scanning-maintainer/scripts/secret-scanning.mjs";
const { createTempDir } = createScriptTestHarness();

describe("secret scanning maintainer script", () => {
  it("marks body alerts as not requiring notification when redaction is unchanged", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const currentBody = path.join(tempDir, "current.md");
    const redactedBody = path.join(tempDir, "redacted.md");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(currentBody, "token: [REDACTED Discord Bot Token]\n");
    fs.writeFileSync(redactedBody, "token: [REDACTED Discord Bot Token]\n");

    const output = execFileSync(
      process.execPath,
      [scriptPath, "redact-body-if-needed", "issue", "123", currentBody, redactedBody, resultFile],
      { encoding: "utf8" },
    );

    expect(JSON.parse(output)).toMatchObject({
      body_changed: false,
      notify_required: false,
      reason: "current_body_already_redacted",
      redacted: false,
    });
    expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({
      notify_required: false,
    });
  });

  it("patches body alerts and requires notification when redaction changes the current body", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const binDir = path.join(tempDir, "bin");
    const ghLog = path.join(tempDir, "gh.log");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "gh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLog}"\nprintf '{}\\n'\n`,
      { mode: 0o755 },
    );

    const currentBody = path.join(tempDir, "current.md");
    const redactedBody = path.join(tempDir, "redacted.md");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(currentBody, "token: plaintext-secret\n");
    fs.writeFileSync(redactedBody, "token: [REDACTED Discord Bot Token]\n");

    const output = execFileSync(
      process.execPath,
      [scriptPath, "redact-body-if-needed", "issue", "123", currentBody, redactedBody, resultFile],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      body_changed: true,
      notify_required: true,
      redacted: true,
    });
    expect(fs.readFileSync(ghLog, "utf8")).toContain(
      `api repos/openclaw/openclaw/issues/123 -X PATCH -F body=@${redactedBody}`,
    );
  });

  it("skips body notification when the redaction result says the current body was already redacted", () => {
    const tempDir = createTempDir("openclaw-secret-scan-");
    const resultFile = path.join(tempDir, "redaction-result.json");
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        body_changed: false,
        notify_required: false,
      }),
    );

    const output = execFileSync(
      process.execPath,
      [scriptPath, "notify", "123", "contributor", "issue_body", "Discord Bot Token", resultFile],
      { encoding: "utf8" },
    );

    expect(JSON.parse(output)).toStrictEqual({
      ok: true,
      reason: "current_body_already_redacted",
      skipped: true,
    });
  });

  it("requires body notifications to include a redaction result file", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [scriptPath, "notify", "123", "contributor", "issue_body", "Discord Bot Token"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow(/Body notifications require a redaction result file/);
  });
});
