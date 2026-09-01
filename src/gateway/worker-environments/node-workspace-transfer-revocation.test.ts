import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { ensureStagedInputDirectory, stagedInputDirectory } from "../../media/staged-inputs.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("attachment transfer revocation", () => {
  it.each([
    { boundary: "blob-admitted", revoke: false },
    { boundary: "blob-admitted", revoke: true },
    { boundary: "before-create-entry", revoke: false },
    { boundary: "before-create-entry", revoke: true },
    { boundary: "inside-create-before-open", revoke: false },
    { boundary: "inside-create-before-open", revoke: true },
    { boundary: "inside-create-after-open", revoke: false },
    { boundary: "inside-create-after-open", revoke: true },
    { boundary: "inside-final-create", revoke: false },
    { boundary: "inside-final-create", revoke: true },
  ] as const)("$boundary revoked=$revoke", async ({ boundary, revoke }) => {
    const root = await fs.realpath(tempDirs.make("attachment-revocation-"));
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source");
    const directory = stagedInputDirectory("a".repeat(64));
    const fresh = `${directory}/input-new.txt`;
    const subsequent = `${directory}/input-subsequent.txt`;
    const existing = `${directory}/input-existing.txt`;
    await fs.mkdir(workspaceDir);
    await fs.mkdir(source);
    for (const parent of [workspaceDir, source]) {
      await ensureStagedInputDirectory(parent, directory);
    }
    await fs.writeFile(path.join(workspaceDir, "project.txt"), "unrelated project");
    await fs.writeFile(path.join(workspaceDir, existing), "prior worker edit");
    await fs.writeFile(path.join(source, existing), "original attachment");
    await fs.writeFile(path.join(source, fresh), "private new input");
    await fs.writeFile(path.join(source, subsequent), "subsequent private input");
    const controller = new AbortController();
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("attachment-revocation"),
      facts: {
        runId: "attachment-revocation",
        agentId: "main",
        ingress: { kind: "worker", boundary: "test.attachment-transfer", state: "present" },
      },
    });
    const admitted = await admission.admit("worker");
    let reached = false;
    const crossBoundary = () => {
      reached = true;
      if (revoke) {
        admission.close();
        controller.abort(new Error("Exact turn revoked during transfer"));
      }
    };
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session", expiresAtMs: Date.now() + 60_000 },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      generation: 1,
      localPath: workspaceDir,
      isAuthorized: () => true,
    });
    const attachmentRequest = {
      environmentId: "environment",
      localPath: source,
      isAuthorized: () => getAdmittedRunDelegatedAuthority(admitted) !== undefined,
      signal: controller.signal,
    };
    const prepared = await service.prepareAttachments(attachmentRequest);
    const entry = prepared.snapshot.manifest.entries.find(
      (candidate) => candidate.path === (boundary === "blob-admitted" ? subsequent : fresh),
    );
    if (entry?.type !== "file") {
      throw new Error("Missing attachment fixture");
    }
    const callback = createNodeWorkspaceTransferHttpCallback(service);
    const server = createServer((req, res) => {
      if (boundary === "blob-admitted" && req.url?.endsWith(`/blobs/${entry.sha256}`)) {
        const writeHead = res.writeHead.bind(res);
        res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
          const result = writeHead(...args);
          if (res.statusCode === 200) {
            crossBoundary();
          }
          return result;
        }) as typeof res.writeHead;
      }
      void handleNodeWorkspaceTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
      }).catch((error: unknown) =>
        res.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    const readsAfterRevocation: string[] = [];
    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const file = typeof args[0] === "string" ? args[0] : "";
      const installing = file.includes(".workspace.workspace-transfer-");
      if (installing && reached && revoke) {
        readsAfterRevocation.push(file);
      }
      const data = await originalReadFile(...args);
      // The real staging read finishes before the installer calls Root.create().
      if (installing && file.endsWith(fresh) && boundary === "before-create-entry") {
        crossBoundary();
      }
      return data;
    });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const creation =
        args[0] ===
          path.join(workspaceDir, boundary === "inside-final-create" ? subsequent : fresh) &&
        typeof args[1] === "number" &&
        (args[1] & fsSync.constants.O_CREAT) !== 0;
      if (creation && boundary === "inside-create-before-open") {
        crossBoundary();
      }
      const handle = await originalOpen(...args);
      if (
        creation &&
        (boundary === "inside-create-after-open" || boundary === "inside-final-create")
      ) {
        crossBoundary();
      }
      return handle;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    try {
      const result = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: `ws://127.0.0.1:${address.port}`,
        environmentId: "environment",
        workspaceDir,
        manifestHome: root,
        transfer: {
          direction: "download",
          token: prepared.token,
          manifestRef: prepared.snapshot.manifestRef,
          attachments: true,
        },
        // At blob admission only the Gateway stream receives cancellation.
        signal: boundary === "blob-admitted" ? undefined : controller.signal,
      }).then(
        () => "completed",
        () => "rejected",
      );
      expect(reached).toBe(true);
      await expect(fs.readFile(path.join(workspaceDir, existing), "utf8")).resolves.toBe(
        "prior worker edit",
      );
      await expect(fs.readFile(path.join(workspaceDir, "project.txt"), "utf8")).resolves.toBe(
        "unrelated project",
      );
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.startsWith(".workspace.workspace-transfer-"),
        ),
      ).toEqual([]);
      if (revoke) {
        expect.soft(result).toBe("rejected");
        expect.soft(readsAfterRevocation).toEqual([]);
        if (boundary.startsWith("inside-")) {
          // fs-safe 0.5.6 cannot cancel or identity-roll back an entered create.
          await expect(fs.readFile(path.join(workspaceDir, fresh), "utf8")).resolves.toBe(
            "private new input",
          );
        } else {
          await expect(fs.stat(path.join(workspaceDir, fresh))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        if (boundary === "inside-final-create") {
          await expect(fs.readFile(path.join(workspaceDir, subsequent), "utf8")).resolves.toBe(
            "subsequent private input",
          );
        } else {
          await expect(fs.stat(path.join(workspaceDir, subsequent))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } else {
        expect(result).toBe("completed");
        await expect(fs.readFile(path.join(workspaceDir, subsequent), "utf8")).resolves.toBe(
          "subsequent private input",
        );
        await expect(fs.readFile(path.join(workspaceDir, fresh), "utf8")).resolves.toBe(
          "private new input",
        );
      }
    } finally {
      admission.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await service.closeAll();
    }
  });
});
