import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = resolve("scripts/docker/shared-image-artifact.sh");
const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const PACKAGE_SHA256 = "c".repeat(64);
const ARTIFACT_DIGEST = "d".repeat(64);
const ARTIFACT_ID = "789";
const ARTIFACT_NAME = "docker-e2e-shared-images-release-aabbccddeeff-123456-2";
const ARTIFACT_RUN_ATTEMPT = "2";
const ARTIFACT_RUN_ID = "123456";
const IMAGE_REFS = ["openclaw-docker-e2e-bare:pkg-test", "openclaw-docker-e2e-functional:pkg-test"];

function imageId(ref: string): string {
  return `sha256:${createHash("sha256").update(ref).digest("hex")}`;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runHelper(params: {
  artifactDir: string;
  command: "load" | "pack";
  env: NodeJS.ProcessEnv;
  imageRefs?: string[];
}) {
  return spawnSync(
    "bash",
    [
      HELPER,
      params.command,
      params.artifactDir,
      "docker-e2e",
      TARGET_SHA,
      WORKFLOW_SHA,
      ...(params.imageRefs ?? IMAGE_REFS),
    ],
    {
      encoding: "utf8",
      env: params.env,
    },
  );
}

function verifyUploadedArtifact(
  fixture: ReturnType<typeof createFixture>,
  params: {
    artifactDigest?: string;
    artifactName?: string;
    env?: NodeJS.ProcessEnv;
    runAttempt?: string;
    runId?: string;
  } = {},
) {
  return spawnSync(
    "bash",
    [
      HELPER,
      "verify-upload",
      "Docker E2E image",
      ARTIFACT_ID,
      params.artifactName ?? ARTIFACT_NAME,
      params.artifactDigest ?? ARTIFACT_DIGEST,
      params.runId ?? ARTIFACT_RUN_ID,
      params.runAttempt ?? ARTIFACT_RUN_ATTEMPT,
    ],
    {
      encoding: "utf8",
      env: { ...fixture.env, ...params.env },
    },
  );
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-shared-image-artifact-"));
  const bin = join(root, "bin");
  const artifactDir = join(root, "artifact");
  const dockerLog = join(root, "docker.log");
  const ghLog = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(dockerLog, "");
  writeFileSync(ghLog, "");

  writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"

image_id() {
  printf '%s' "$1" | sha256sum | awk '{print "sha256:" $1}'
}

if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  ref="\${5:?image ref required}"
  id="$(image_id "$ref")"
  if [[ "\${FAKE_DOCKER_FORCE_ID_MISMATCH:-0}" == "1" ]]; then
    id="sha256:$(printf 'mismatch:%s' "$ref" | sha256sum | awk '{print $1}')"
  fi
  printf '%s\\n' "$id"
  exit 0
fi

if [[ "$1" == "image" && "$2" == "save" ]]; then
  shift 2
  output=""
  refs=()
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --output)
        output="\${2:?output path required}"
        shift 2
        ;;
      *)
        refs+=("$1")
        shift
        ;;
    esac
  done
  : > "$output"
  for ref in "\${refs[@]}"; do
    printf '%s\\t%s\\n' "$ref" "$(image_id "$ref")" >> "$output"
  done
  exit 0
fi

if [[ "$1" == "image" && "$2" == "load" ]]; then
  cat >/dev/null
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 2
`,
  );

  writeExecutable(
    join(bin, "zstd"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-t" ]]; then
  test -s "$2"
  exit 0
fi
if [[ "$1" == "-d" && "$2" == "--stdout" ]]; then
  cat "$3"
  exit 0
fi

source_path=""
output_path=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -f)
      source_path="\${2:?source path required}"
      shift 2
      ;;
    -o)
      output_path="\${2:?output path required}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "$source_path" "$output_path"
`,
  );

  writeExecutable(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
[[ "$1" == "api" ]] || {
  echo "unexpected gh invocation: $*" >&2
  exit 2
}
path="$2"
case "$path" in
  "repos/\${GITHUB_REPOSITORY}/actions/artifacts/${ARTIFACT_ID}")
    printf '{"id":%s,"name":"%s","expired":%s,"digest":"sha256:%s","workflow_run":{"id":%s}}\\n' \
      "$FAKE_ARTIFACT_ID" "$FAKE_ARTIFACT_NAME" "$FAKE_ARTIFACT_EXPIRED" \
      "$FAKE_ARTIFACT_DIGEST" "$FAKE_ARTIFACT_RUN_ID"
    ;;
  "repos/\${GITHUB_REPOSITORY}/actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}")
    printf '{"id":%s,"run_attempt":%s}\\n' \
      "$FAKE_ATTEMPT_RUN_ID" "$FAKE_ARTIFACT_RUN_ATTEMPT"
    ;;
  *)
    echo "unexpected gh api path: $path" >&2
    exit 2
    ;;
esac
`,
  );

  const env = {
    ...process.env,
    FAKE_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
    FAKE_ARTIFACT_EXPIRED: "false",
    FAKE_ARTIFACT_ID: ARTIFACT_ID,
    FAKE_ARTIFACT_NAME: ARTIFACT_NAME,
    FAKE_ARTIFACT_RUN_ATTEMPT: ARTIFACT_RUN_ATTEMPT,
    FAKE_ARTIFACT_RUN_ID: ARTIFACT_RUN_ID,
    FAKE_ATTEMPT_RUN_ID: ARTIFACT_RUN_ID,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_GH_LOG: ghLog,
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "123456",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: root,
    OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256: PACKAGE_SHA256,
  };
  return { artifactDir, dockerLog, env, ghLog, root };
}

function expectedArchiveEnv(fixture: ReturnType<typeof createFixture>): NodeJS.ProcessEnv {
  const manifest = JSON.parse(
    readFileSync(join(fixture.artifactDir, "shared-image-artifact.json"), "utf8"),
  );
  return {
    ...fixture.env,
    OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: manifest.archive.sha256,
    OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: String(manifest.runAttempt),
    OPENCLAW_SHARED_IMAGE_RUN_ID: String(manifest.runId),
  };
}

describe("shared Docker image artifacts", () => {
  it("binds uploaded artifacts to the exact service tuple and producer attempt", () => {
    const fixture = createFixture();
    try {
      const verified = verifyUploadedArtifact(fixture);
      expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
      expect(readFileSync(fixture.ghLog, "utf8")).toContain(
        `api repos/openclaw/openclaw/actions/artifacts/${ARTIFACT_ID}`,
      );
      expect(readFileSync(fixture.ghLog, "utf8")).toContain(
        `api repos/openclaw/openclaw/actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}`,
      );

      const digestMismatch = verifyUploadedArtifact(fixture, {
        artifactDigest: "e".repeat(64),
      });
      expect(digestMismatch.status).not.toBe(0);
      expect(digestMismatch.stderr).toContain(
        "artifact identity does not match the immutable producer tuple",
      );

      const attemptMismatch = verifyUploadedArtifact(fixture, {
        env: { FAKE_ARTIFACT_RUN_ATTEMPT: "3" },
      });
      expect(attemptMismatch.status).not.toBe(0);
      expect(attemptMismatch.stderr).toContain(
        "producer run attempt does not match the immutable tuple",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("packs provenance-bound images and verifies them before loading", () => {
    const fixture = createFixture();
    try {
      const packed = runHelper({
        artifactDir: fixture.artifactDir,
        command: "pack",
        env: fixture.env,
      });
      expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);

      const archive = readFileSync(join(fixture.artifactDir, "shared-images.tar.zst"));
      const manifest = JSON.parse(
        readFileSync(join(fixture.artifactDir, "shared-image-artifact.json"), "utf8"),
      );
      expect(manifest).toEqual({
        archive: {
          filename: "shared-images.tar.zst",
          format: "docker-tar+zstd",
          sha256: createHash("sha256").update(archive).digest("hex"),
          sizeBytes: archive.length,
        },
        conclusion: "success",
        images: IMAGE_REFS.map((ref) => ({ id: imageId(ref), ref })),
        kind: "docker-e2e",
        packageSha256: PACKAGE_SHA256,
        packageSourceSha: TARGET_SHA,
        runAttempt: 2,
        runId: 123456,
        schema: "openclaw.shared-docker-image-artifact/v1",
        schemaVersion: 1,
        targetSha: TARGET_SHA,
        workflowSha: WORKFLOW_SHA,
      });

      writeFileSync(fixture.dockerLog, "");
      const loaded = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: { ...expectedArchiveEnv(fixture), GITHUB_RUN_ATTEMPT: "3" },
      });
      expect(loaded.status, `${loaded.stdout}\n${loaded.stderr}`).toBe(0);
      const calls = readFileSync(fixture.dockerLog, "utf8");
      expect(calls).toContain("image load");
      for (const ref of IMAGE_REFS) {
        expect(calls).toContain(`image inspect --format {{.Id}} ${ref}`);
      }
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails before loading when provenance or archive bytes differ", () => {
    const fixture = createFixture();
    try {
      const packed = runHelper({
        artifactDir: fixture.artifactDir,
        command: "pack",
        env: fixture.env,
      });
      expect(packed.status, packed.stderr).toBe(0);

      for (const variant of [
        {
          env: {
            ...expectedArchiveEnv(fixture),
            OPENCLAW_SHARED_IMAGE_RUN_ID: "654321",
          },
          imageRefs: IMAGE_REFS,
          expected: "run ID",
        },
        {
          env: expectedArchiveEnv(fixture),
          imageRefs: [IMAGE_REFS[0], "openclaw-docker-e2e-functional:wrong"],
          expected: "image ref 1",
        },
        {
          env: {
            ...expectedArchiveEnv(fixture),
            OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256: "d".repeat(64),
          },
          imageRefs: IMAGE_REFS,
          expected: "package SHA-256",
        },
      ]) {
        writeFileSync(fixture.dockerLog, "");
        const result = runHelper({
          artifactDir: fixture.artifactDir,
          command: "load",
          env: variant.env,
          imageRefs: variant.imageRefs,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(variant.expected);
        expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");
      }

      const archivePath = join(fixture.artifactDir, "shared-images.tar.zst");
      writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}tampered`);
      writeFileSync(fixture.dockerLog, "");
      const tampered = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: expectedArchiveEnv(fixture),
      });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("archive SHA-256 mismatch");
      expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects unsafe pack destinations and loaded image ID drift", () => {
    const fixture = createFixture();
    try {
      const unsafe = runHelper({
        artifactDir: fixture.root,
        command: "pack",
        env: fixture.env,
      });
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toContain("artifact directory must be a child of RUNNER_TEMP");

      const packed = runHelper({
        artifactDir: fixture.artifactDir,
        command: "pack",
        env: fixture.env,
      });
      expect(packed.status, packed.stderr).toBe(0);

      writeFileSync(fixture.dockerLog, "");
      const mismatch = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: { ...expectedArchiveEnv(fixture), FAKE_DOCKER_FORCE_ID_MISMATCH: "1" },
      });
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain("loaded ID mismatch");
      expect(readFileSync(fixture.dockerLog, "utf8")).toContain("image load");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires an external expected archive digest before loading", () => {
    const fixture = createFixture();
    try {
      const packed = runHelper({
        artifactDir: fixture.artifactDir,
        command: "pack",
        env: fixture.env,
      });
      expect(packed.status, packed.stderr).toBe(0);

      const missingRunEnv = expectedArchiveEnv(fixture);
      delete missingRunEnv.OPENCLAW_SHARED_IMAGE_RUN_ID;
      delete missingRunEnv.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT;
      const missingRun = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: missingRunEnv,
      });
      expect(missingRun.status).not.toBe(0);
      expect(missingRun.stderr).toContain("OPENCLAW_SHARED_IMAGE_RUN_ID");
      expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");

      const missing = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: {
          ...fixture.env,
          OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: "2",
          OPENCLAW_SHARED_IMAGE_RUN_ID: "123456",
        },
      });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("expected shared image archive SHA-256");
      expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");

      const mismatched = runHelper({
        artifactDir: fixture.artifactDir,
        command: "load",
        env: {
          ...expectedArchiveEnv(fixture),
          OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: "d".repeat(64),
        },
      });
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain("expected archive sha256");
      expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain("image load");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
