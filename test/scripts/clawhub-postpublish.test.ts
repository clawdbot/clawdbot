import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClawHubParentAuthorization,
  readPackedClawHubTransaction,
} from "../../scripts/clawhub-parent-authorization.mjs";
import { verifyClawHubPostpublish } from "../../scripts/clawhub-postpublish.mjs";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const sha = "a".repeat(40);
const ref = `release-publish/${sha.slice(0, 12)}-1`;
const repository = "openclaw/openclaw";
const parentWorkflow = ".github/workflows/openclaw-release-publish.yml";
const childWorkflow = ".github/workflows/plugin-clawhub-release.yml";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function zip(name: string, bytes: Buffer) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + bytes.length, 16);
  return Buffer.concat([local, fileName, bytes, central, fileName, end]);
}

function fixture(parentOnMain = false) {
  const parentRef = parentOnMain ? "main" : ref;
  const parentFullRef = parentOnMain ? "refs/heads/main" : `refs/tags/${ref}`;
  const directory = mkdtempSync(join(tmpdir(), "clawhub-postpublish-"));
  directories.push(directory);
  const packageDir = join(directory, "package");
  const artifactDir = join(directory, "artifact");
  mkdirSync(packageDir);
  mkdirSync(artifactDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@openclaw/example", version: "2026.8.2" }),
  );
  writeFileSync(join(packageDir, "openclaw.plugin.json"), JSON.stringify({ id: "example" }));
  const tarballPath = join(artifactDir, "example.tgz");
  tar.create(
    {
      sync: true,
      cwd: directory,
      file: tarballPath,
      gzip: true,
      portable: true,
      mtime: new Date("1985-10-26T08:15:00.000Z"),
      noPax: true,
    },
    ["package/package.json", "package/openclaw.plugin.json"],
  );
  const tarball = readFileSync(tarballPath);
  const entry = readPackedClawHubTransaction({
    artifactDir,
    packageName: "@openclaw/example",
    version: "2026.8.2",
    artifactName: "package-example",
  });
  const identity = {
    version: 2,
    repository,
    workflow: childWorkflow,
    runId: "20",
    runAttempt: "1",
    ref,
    fullRef: `refs/tags/${ref}`,
    sha,
    candidateRepository: repository,
    candidateSha: "b".repeat(40),
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha: sha,
    parentRepository: repository,
    parentWorkflow,
    parentRunId: "10",
    parentRunAttempt: "1",
  };
  const transactions = { schemaVersion: 1, identity, packages: [entry] };
  const receipt = createClawHubParentAuthorization(transactions, "automated-awaited");
  const run = (id: number, path: string) => ({
    id,
    run_attempt: 1,
    path: `${path}@${id === 10 ? parentFullRef : `refs/tags/${ref}`}`,
    head_sha: sha,
    head_branch: id === 10 ? parentRef : ref,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  });
  const parent = run(10, parentWorkflow);
  const child = run(20, childWorkflow);
  const archives = new Map<number, Buffer>();
  const artifact = (id: number, name: string, runId: number, fileName: string, bytes: Buffer) => {
    const archive = zip(fileName, bytes);
    archives.set(id, archive);
    return {
      id,
      name,
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      workflow_run: { id: runId, head_sha: sha },
    };
  };
  const receiptArtifact = artifact(
    1,
    "openclaw-clawhub-parent-authorization-v2-10-1-20-1",
    10,
    "authorization.json",
    Buffer.from(JSON.stringify(receipt)),
  );
  const transactionsArtifact = artifact(
    2,
    "openclaw-clawhub-transactions-20-1",
    20,
    "transactions.json",
    Buffer.from(JSON.stringify(transactions)),
  );
  const packageArtifact = artifact(3, "package-example", 20, "example.tgz", tarball);
  const dispatch = {
    schemaVersion: 1,
    repository,
    parentRunId: "10",
    parentRunAttempt: "1",
    parentWorkflow,
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha: sha,
    candidateSha: identity.candidateSha,
    normalClawHubRunId: "20",
    normalClawHubRunAttempt: "1",
  };
  const dispatchArtifact = artifact(
    4,
    "openclaw-release-children-10-1",
    10,
    "dispatch.json",
    Buffer.from(JSON.stringify(dispatch)),
  );
  const metadata = new Map<string, unknown>([
    ["actions/runs/10/attempts/1", parent],
    ["actions/runs/20/attempts/1", child],
    ["actions/runs/20", child],
    [
      "actions/runs/10/artifacts?per_page=100&page=1",
      { total_count: 2, artifacts: [receiptArtifact, dispatchArtifact] },
    ],
    [
      "actions/runs/20/artifacts?per_page=100&page=1",
      { total_count: 2, artifacts: [transactionsArtifact, packageArtifact] },
    ],
    [
      "actions/runs/20/artifacts?name=openclaw-clawhub-transactions-20-1&per_page=100",
      { total_count: 1, artifacts: [transactionsArtifact] },
    ],
    [
      "actions/runs/20/attempts/1/jobs?per_page=100&page=1",
      {
        total_count: 1,
        jobs: [
          {
            name: "Seal ClawHub package transactions",
            run_id: 20,
            run_attempt: 1,
            head_sha: sha,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    [`git/ref/tags/${ref}`, { ref: `refs/tags/${ref}`, object: { type: "commit", sha } }],
    [`git/matching-refs/heads/${ref}`, []],
    [`compare/${sha}...main`, { status: "identical" }],
    [`compare/${sha}...${sha}`, { status: "identical" }],
    ...[receiptArtifact, transactionsArtifact, packageArtifact, dispatchArtifact].map(
      (item): [string, unknown] => [`actions/artifacts/${item.id}`, item],
    ),
  ]);
  const registryReads: string[] = [];
  const archiveIdentity = {
    sha256: digest(tarball),
    size: tarball.length,
    npmIntegrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    npmShasum: createHash("sha1").update(tarball).digest("hex"),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    expect(init?.method ?? "GET").toBe("GET");
    if (url.hostname === "api.github.com") {
      const path = `${url.pathname.replace(`/repos/${repository}/`, "")}${url.search}`;
      const download = /^actions\/artifacts\/(\d+)\/zip$/u.exec(path);
      if (download) return new Response(new Uint8Array(archives.get(Number(download[1]))!));
      if (!metadata.has(path)) throw new Error(`Unexpected GitHub request: ${path}`);
      return Response.json(metadata.get(path));
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    registryReads.push(url.pathname);
    if (url.pathname.endsWith("/trusted-publisher"))
      return Response.json({
        trustedPublisher: {
          provider: "github-actions",
          repository,
          workflowFilename: "plugin-clawhub-release.yml",
        },
      });
    if (url.pathname.endsWith("/artifact/download"))
      return new Response(new Uint8Array(tarball), {
        headers: {
          "x-clawhub-artifact-sha256": archiveIdentity.sha256,
          "x-clawhub-npm-integrity": archiveIdentity.npmIntegrity,
          "x-clawhub-npm-shasum": archiveIdentity.npmShasum,
        },
      });
    if (url.pathname.endsWith("/artifact"))
      return Response.json({
        package: { name: entry.name },
        version: entry.version,
        artifact: { kind: "npm-pack", ...archiveIdentity },
      });
    return Response.json({ package: { tags: { latest: entry.version } } });
  };
  const options = {
    event: { workflow_run: parent },
    verifierSha: sha,
    token: "fixture-token",
    outputDir: join(directory, "result"),
    fetchImpl,
    runGh: (args: string[]) => {
      const apiPath = args[1];
      if (apiPath === undefined) throw new Error("Missing GitHub API path.");
      const key = apiPath.replace(`repos/${repository}/`, "");
      if (!metadata.has(key)) throw new Error(`Unexpected gh request: ${key}`);
      return JSON.stringify(metadata.get(key));
    },
  };
  return {
    options,
    parent,
    child,
    metadata,
    archives,
    registryReads,
    transactions,
    entry,
    receiptArtifact,
    dispatch,
    dispatchArtifact,
    receipt,
  };
}

describe("ClawHub detached postpublish verification", () => {
  it.each([
    { label: "protected-tag parent", parentOnMain: false },
    { label: "main parent and protected-tag child", parentOnMain: true },
  ])(
    "reads the exact authorized bytes after both attempts succeed for $label",
    async ({ parentOnMain }) => {
      const f = fixture(parentOnMain);
      const result = await verifyClawHubPostpublish(f.options);
      expect(result.complete).toBe(true);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        inventoryDigest: f.entry.inventoryDigest,
        publicationAuthentication: "not-verified",
      });
      expect(f.registryReads.length).toBeGreaterThan(0);
    },
  );

  it.each(["failure", "cancelled"])(
    "does not contact the registry for a %s child",
    async (conclusion) => {
      const f = fixture();
      f.child.conclusion = conclusion;
      await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/authorized state/u);
      expect(f.registryReads).toEqual([]);
    },
  );

  it("rejects a replayed successful parent event before downloading artifacts", async () => {
    const f = fixture();
    f.metadata.set("actions/runs/10/attempts/1", { ...f.parent, run_attempt: 2 });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/runAttempt mismatch/u);
    expect(f.registryReads).toEqual([]);
  });

  it("records an explicit no-child outcome without claiming registry verification", async () => {
    const f = fixture();
    const archive = zip(
      "dispatch.json",
      Buffer.from(
        JSON.stringify({ ...f.dispatch, normalClawHubRunId: null, normalClawHubRunAttempt: null }),
      ),
    );
    f.archives.set(4, archive);
    Object.assign(f.dispatchArtifact, {
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
    });
    const result = await verifyClawHubPostpublish(f.options);
    expect(result).toMatchObject({
      complete: true,
      outcome: "no-normal-clawhub-publication",
      packages: [],
    });
    expect(f.registryReads).toEqual([]);
  });

  it("does not mistake a missing dispatch record for an empty release", async () => {
    const f = fixture();
    f.metadata.set("actions/runs/10/artifacts?per_page=100&page=1", {
      total_count: 0,
      artifacts: [],
    });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/dispatch record/u);
    expect(f.registryReads).toEqual([]);
  });

  it("rejects a different parent-approved inventory even when all archive digests verify", async () => {
    const f = fixture();
    const receipt = {
      ...f.receipt,
      packages: [{ ...f.receipt.packages[0], inventoryDigest: "f".repeat(64) }],
    };
    const archive = zip("authorization.json", Buffer.from(JSON.stringify(receipt)));
    f.archives.set(1, archive);
    Object.assign(f.receiptArtifact, {
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
    });
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(
      /Parent authorization packages mismatch/u,
    );
    expect(f.registryReads).toEqual([]);
  });

  it("rejects package archive substitution before contacting the registry", async () => {
    const f = fixture();
    f.archives.set(3, zip("example.tgz", Buffer.from("substituted")));
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/(size|digest|bytes)/u);
    expect(f.registryReads).toEqual([]);
  });
});
