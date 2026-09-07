import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferReconcilePath,
} from "../../worker/node-workspace-transfer-protocol.js";
import { environment } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const baseCommit = "a".repeat(40);
const baseManifestRaw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit, entries: [] });
const baseManifestRef = `sha256:${createHash("sha256").update(baseManifestRaw).digest("hex")}`;

type ClosingBoundary = "seed" | "fetch" | "author" | "setup" | "checkpoint" | "upload";

async function repositoryFixture(closeAt?: ClosingBoundary) {
  const root = tempDirs.make("node-repository-authority-");
  const record = environment();
  const transfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: () => ({
      environment: record,
      credential: { ownerEpoch: record.ownerEpoch, sessionId: "session-1" },
    }),
  });
  let authorized = true;
  let closedAtBoundary = false;
  let effectsAfterClosure = 0;
  let downloadStatus: number | undefined;
  const actions = createNodeWorkerWorkspaceActions({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId: "session-1",
    ownerSignal: new AbortController().signal,
    isOwnerCurrent: () => true,
    workspaceTransfer: transfer,
    runWorkspaceCommand: async (command) => {
      if (closeAt === "upload" && command.transfer?.direction === "upload") {
        await Promise.resolve();
        authorized = false;
        closedAtBoundary = true;
      }
      command.assertCurrent?.();
      if (!authorized) {
        effectsAfterClosure += 1;
      }
      // Model revocation while remote I/O is outstanding, not an aborted tunnel.
      await Promise.resolve();
      const boundary: ClosingBoundary | undefined =
        command.seed?.action === "apply"
          ? "seed"
          : command.argv.includes("fetch")
            ? "fetch"
            : command.argv.includes("config")
              ? "author"
              : command.transfer?.direction === "download"
                ? "checkpoint"
                : command.argv.some((arg) => arg.includes("worktree-setup.sh"))
                  ? "setup"
                  : undefined;
      if (closeAt && boundary === closeAt) {
        authorized = false;
        closedAtBoundary = true;
      }
      let stdout = command.argv.includes("rev-parse") ? baseCommit : baseManifestRef;
      if (command.seed?.action === "apply") {
        stdout = "missing";
      }
      if (command.transfer?.direction === "download") {
        const server = await startNodeWorkspaceTransferTestServer(transfer);
        try {
          const response = await fetch(
            server.gatewayUrl.replace("ws:", "http:") +
              nodeWorkspaceTransferManifestPath(record.environmentId, command.transfer.manifestRef),
            { headers: { authorization: `Bearer ${command.transfer.token}` } },
          );
          downloadStatus = response.status;
          await response.arrayBuffer();
          if (response.status !== 200) {
            throw new Error("Repository checkpoint download authority closed");
          }
        } finally {
          await server.close();
        }
        stdout = command.transfer.manifestRef;
      }
      return {
        workspaceDir: "/node/workspace",
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    },
  });
  const authorize = () => {
    if (!authorized) {
      throw new Error("Initiating dispatch turn closed");
    }
  };
  const sync = (checkpoint = false) =>
    actions.syncWorkspace({
      sessionId: "session-1",
      generation: 1,
      gitAuthor: { name: "Repository Test", email: "repository@example.invalid" },
      source: {
        kind: "repository",
        url: "https://github.com/example/repository.git",
        branch: "openclaw/session",
        baseCommit,
        runSetupScript: !checkpoint,
        ...(checkpoint
          ? {
              checkpoint: {
                stagingRoot: root,
                baseManifestRaw,
                currentManifestRaw: baseManifestRaw,
              },
            }
          : {}),
      },
      authorize,
    });
  return {
    sync,
    temporaryRoot: path.join(root, "transfers"),
    actions,
    authorize,
    transfer,
    closeInvocation: () => {
      authorized = false;
    },
    observed: () => ({ closedAtBoundary, effectsAfterClosure, downloadStatus }),
  };
}

it.each(["seed", "fetch", "author", "setup", "checkpoint"] as const)(
  "fences repository preparation when its initiating turn closes during %s",
  async (boundary) => {
    const fixture = await repositoryFixture(boundary);
    try {
      await expect(fixture.sync(boundary === "checkpoint")).rejects.toThrow(
        /authority closed|turn closed/u,
      );
      expect(fixture.observed()).toMatchObject({ closedAtBoundary: true, effectsAfterClosure: 0 });
      if (boundary === "checkpoint") {
        expect(fixture.observed().downloadStatus).toBe(404);
      }
    } finally {
      await fixture.transfer.closeAll();
    }
  },
);

it("retains repository workspace custody after a successful initiating turn closes", async () => {
  const fixture = await repositoryFixture();
  try {
    const result = await fixture.sync(true);
    expect(fixture.observed().downloadStatus).toBe(200);
    fixture.closeInvocation();
    const token = fixture.transfer.prepareUpload("environment-1", result.manifestRef);
    expect(token).toBeTruthy();
    await fixture.transfer.revoke("environment-1", token);
  } finally {
    await fixture.transfer.closeAll();
  }
});

it("fences the initial repository checkpoint when dispatch authority closes during node lookup", async () => {
  const fixture = await repositoryFixture("upload");
  try {
    const synced = await fixture.sync();
    await expect(
      fixture.actions.reconcileWorkspace({
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        baseManifestRef,
        source: {
          kind: "repository",
          authorize: fixture.authorize,
          referenceManifestRef: synced.manifestRef,
          prepareCheckpoint: async () => {
            throw new Error("Unexpected checkpoint publication");
          },
        },
      }),
    ).rejects.toThrow("Initiating dispatch turn closed");
    expect(fixture.observed()).toMatchObject({ closedAtBoundary: true, effectsAfterClosure: 0 });
  } finally {
    await fixture.transfer.closeAll();
  }
});

it("rejects a retained initial-checkpoint upload token before reading its HTTP body", async () => {
  const fixture = await repositoryFixture();
  const server = await startNodeWorkspaceTransferTestServer(fixture.transfer);
  try {
    await fixture.sync();
    const token = fixture.transfer.prepareUpload(
      "environment-1",
      baseManifestRef,
      fixture.authorize,
    );
    fixture.closeInvocation();
    const response = await fetch(
      server.gatewayUrl.replace("ws:", "http:") +
        nodeWorkspaceTransferReconcilePath("environment-1", baseManifestRef),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "unread stale upload",
      },
    );
    await response.arrayBuffer();
    expect(response.status).toBe(404);
  } finally {
    await server.close();
    await fixture.transfer.closeAll();
  }
});

it("releases a completed upload rejected after caller closure so a fresh checkpoint can proceed", async () => {
  const fixture = await repositoryFixture();
  const server = await startNodeWorkspaceTransferTestServer(fixture.transfer);
  try {
    await fixture.sync();
    const token = fixture.transfer.prepareUpload(
      "environment-1",
      baseManifestRef,
      fixture.authorize,
    );
    const manifest = Buffer.from(baseManifestRaw);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifest.length);
    const response = await fetch(
      server.gatewayUrl.replace("ws:", "http:") +
        nodeWorkspaceTransferReconcilePath("environment-1", baseManifestRef),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: Buffer.concat([header, manifest, header, manifest]),
      },
    );
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    const staged = (await fs.readdir(fixture.temporaryRoot, { recursive: true })).filter((entry) =>
      path.basename(entry).startsWith("upload-"),
    );
    expect(staged).toHaveLength(1);
    fixture.closeInvocation();
    expect(() => fixture.transfer.takeUpload("environment-1", baseManifestRef)).toThrow();
    await fixture.transfer.revoke("environment-1", token);
    const fresh = fixture.transfer.prepareUpload("environment-1", baseManifestRef, () => {});
    expect(fresh).not.toBe(token);
    await expect(fs.stat(path.join(fixture.temporaryRoot, staged[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.transfer.revoke("environment-1", fresh);
  } finally {
    await server.close();
    await fixture.transfer.closeAll();
  }
});
