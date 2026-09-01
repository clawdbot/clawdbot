import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/notarize-mac-artifact.sh";

describe("notarize-mac-artifact input validation", () => {
  it("prints help without checking artifact or notary tools", () => {
    const result = spawnSync("bash", [scriptPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/notarize-mac-artifact.sh <artifact>");
    expect(result.stdout).toContain("NOTARYTOOL_PROFILE");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown options before artifact validation", () => {
    const result = spawnSync("bash", [scriptPath, "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unknown notarization option: --wat");
  });

  it("rejects extra artifact arguments before notarization", () => {
    const tempRoot = tempDirs.make("openclaw-notary-extra-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("bash", [scriptPath, artifact, "extra"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Error: unexpected notarization argument: extra");
  });

  it("fails before notarization when an explicit staple app path is missing", () => {
    const tempRoot = tempDirs.make("openclaw-notary-staple-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const missingApp = path.join(tempRoot, "Missing.app");
    writeFileSync(artifact, "placeholder", "utf8");

    const result = spawnSync("bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        STAPLE_APP_PATH: missingApp,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: STAPLE_APP_PATH not found");
    expect(result.stderr).not.toContain("xcrun not found");
    expect(result.stderr).not.toContain("Notary auth missing");
    expect(result.stdout).not.toContain("Notarizing:");
  });

  it("records the accepted notarization id before stapling", () => {
    const tempRoot = tempDirs.make("openclaw-notary-result-");
    const artifact = path.join(tempRoot, "OpenClaw.zip");
    const app = path.join(tempRoot, "OpenClaw.app");
    const binDir = path.join(tempRoot, "bin");
    const resultPath = path.join(tempRoot, "notary-result.json");
    const accepted = {
      id: "11111111-2222-3333-4444-555555555555",
      status: "Accepted",
      message: "Processing complete",
    };
    writeFileSync(artifact, "placeholder", "utf8");
    mkdirSync(app);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "xcrun"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "notarytool" ]]; then',
        `  printf '%s\\n' '${JSON.stringify(accepted)}'`,
        "  exit 0",
        "fi",
        '[[ "${1:-}" == "stapler" ]]',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(binDir, "xcrun"), 0o755);

    const result = spawnSync("bash", [scriptPath, artifact], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NOTARYTOOL_PROFILE: "test-profile",
        NOTARY_RESULT_FILE: resultPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        STAPLE_APP_PATH: app,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(accepted);
    expect(statSync(resultPath).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(accepted.id);
    expect(result.stdout).toContain("Notarization complete");
  });
});

const submissionId = "11111111-2222-4333-8444-555555555555";

function notarizationFixture(extension = "zip") {
  const root = tempDirs.make("openclaw-notary-resume-");
  const artifact = path.join(root, `OpenClaw.${extension}`);
  const submission = path.join(root, "submission.json");
  const result = path.join(root, "accepted.json");
  const calls = path.join(root, "calls.jsonl");
  const control = path.join(root, "control.json");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(artifact, "signed artifact");
  writeFileSync(control, JSON.stringify({ failFirstWait: true }));
  writeFileSync(
    path.join(bin, "xcrun"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = ${JSON.stringify(calls)};
const prior = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\\n").map(JSON.parse) : [];
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
if (args[0] === "notarytool") {
  if (args[1] === "wait" && control.failFirstWait && !prior.some(call => call[1] === "wait")) {
    console.error("network connection lost while waiting");
    process.exit(1);
  }
  console.log(JSON.stringify({id: ${JSON.stringify(submissionId)}, status: args.includes("--no-wait") ? "In Progress" : (control.status || "Accepted"), message: "Apple response"}));
  if (args[1] === "wait" && control.status === "Invalid") process.exit(65);
} else if (args[0] === "stapler" && args[1] === "staple") {
  fs.appendFileSync(args[2], " stapled ticket");
  if (control.failStage === "staple") process.exit(1);
} else if (args[0] === "stapler" && args[1] === "validate" && control.failStage === "validate") {
  process.exit(1);
}
`,
  );
  chmodSync(path.join(bin, "xcrun"), 0o755);
  return {
    artifact,
    submission,
    result,
    control,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
    run: () =>
      spawnSync("bash", [scriptPath, artifact, "--submission-file", submission], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          NOTARYTOOL_PROFILE: "test-profile",
          NOTARY_RESULT_FILE: result,
          STAPLE_APP_PATH: "",
        },
      }),
  };
}

describe("notarization submission recovery", () => {
  it("resumes a failed wait without submitting again and keeps the accepted result contract", () => {
    const fixture = notarizationFixture();
    const first = fixture.run();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("network connection lost");
    expect(JSON.parse(readFileSync(fixture.submission, "utf8"))).toMatchObject({
      version: 1,
      submissionId,
    });
    expect(statSync(fixture.submission).mode & 0o777).toBe(0o600);
    expect(existsSync(fixture.result)).toBe(false);
    const resumed = fixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "wait", "wait"]);
    expect(fixture.calls()[0]).toContain("--no-wait");
    expect(fixture.calls()[2]?.[2]).toBe(submissionId);
    expect(JSON.parse(readFileSync(fixture.result, "utf8"))).toEqual({
      id: submissionId,
      status: "Accepted",
      message: "Apple response",
    });
    expect(statSync(fixture.result).mode & 0o777).toBe(0o600);
  });

  it.each(["changed artifact", "corrupt checkpoint", "wrong artifact name"])(
    "rejects %s before calling Apple",
    (scenario) => {
      const fixture = notarizationFixture();
      expect(fixture.run().status).toBe(1);
      const calls = fixture.calls();
      if (scenario === "changed artifact") {
        writeFileSync(fixture.artifact, "different signed bytes");
      } else if (scenario === "corrupt checkpoint") {
        writeFileSync(fixture.submission, "not JSON");
      } else {
        const checkpoint = JSON.parse(readFileSync(fixture.submission, "utf8"));
        checkpoint.artifactName = "Other.zip";
        writeFileSync(fixture.submission, JSON.stringify(checkpoint));
      }
      const resumed = fixture.run();
      expect(resumed.status).toBe(1);
      expect(resumed.stderr).toContain("checkpoint");
      expect(fixture.calls()).toEqual(calls);
    },
  );

  it("retains Apple's terminal rejection without publishing accepted output or resubmitting", () => {
    const fixture = notarizationFixture();
    writeFileSync(fixture.control, JSON.stringify({ status: "Invalid" }));
    expect(fixture.run().status).toBe(65);
    expect(fixture.run().status).toBe(1);
    expect(fixture.calls().map((call) => call[1])).toEqual(["submit", "wait"]);
    expect(existsSync(fixture.result)).toBe(false);
  });

  it.each(["staple", "validate"])(
    "preserves original DMG bytes when %s fails and resumes without a second submission",
    (failStage) => {
      const fixture = notarizationFixture("dmg");
      writeFileSync(fixture.control, JSON.stringify({ failStage }));
      expect(fixture.run().status).toBe(1);
      expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact");
      expect(
        readdirSync(path.dirname(fixture.artifact)).filter(
          (name) => name.startsWith(".notary-staple") || name.includes(".tmp."),
        ),
      ).toEqual([]);
      writeFileSync(fixture.control, "{}");
      const resumed = fixture.run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
      expect(fixture.calls().filter((call) => call[1] === "wait")).toHaveLength(1);
      expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact stapled ticket");
    },
  );

  it("recognizes the stapled DMG on a repeated invocation without uploading its changed bytes", () => {
    const fixture = notarizationFixture("dmg");
    writeFileSync(fixture.control, "{}");
    const first = fixture.run();
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(fixture.artifact, "utf8")).toBe("signed artifact stapled ticket");
    const resumed = fixture.run();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fixture.calls().filter((call) => call[1] === "submit")).toHaveLength(1);
    expect(fixture.calls().filter((call) => call[1] === "wait")).toHaveLength(1);
    expect(fixture.calls().filter((call) => call[1] === "staple")).toHaveLength(1);
    writeFileSync(fixture.artifact, "tampered after stapling");
    const calls = fixture.calls();
    expect(fixture.run().status).toBe(1);
    expect(fixture.calls()).toEqual(calls);
  });
});
