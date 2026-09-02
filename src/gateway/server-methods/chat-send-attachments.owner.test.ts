import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

it.each(["off", "all"] as const)(
  "prepares both owners' global attachments with sandbox %s",
  async (mode) => {
    await withOpenClawTestState({ label: "gateway-media-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: state.path("main") },
            work: { workspace: state.path("work") },
          },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode,
              scope: "agent" as const,
              workspaceRoot: state.path("sandboxes"),
              workspaceAccess: "none" as const,
            },
          },
        },
        session: { scope: "global" as const },
      };
      const paths: string[] = [];
      for (const agentId of ["main", "work"]) {
        const bytes = `${agentId} attachment contents`;
        const request = normalizeChatSendRequest({
          client: null,
          params: {
            agentId,
            sessionKey: "global",
            message: "read the file",
            idempotencyKey: `media-${agentId}`,
            attachments: [
              {
                fileName: "notes.txt",
                mimeType: "text/plain",
                content: Buffer.from(bytes).toString("base64"),
              },
            ],
          },
        });
        expect(request.ok).toBe(true);
        if (!request.ok) {
          throw new Error(request.error);
        }
        const respond = vi.fn();
        const result = await prepareChatSendAttachments({
          request: request.value,
          session: {
            cfg,
            sessionKey: "global",
            agentId,
            resolvedSessionModel: { provider: "fixture", model: "fixture" },
            clientRunId: `media-${agentId}`,
          },
          admission: {
            activeRunAbort: { controller: new AbortController() },
            cleanupAdmittedRun() {},
          },
          context: { logGateway: createSubsystemLogger("test/media-owner") },
          respond,
        } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
        expect(respond.mock.calls).toEqual([]);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("attachment preparation failed");
        }
        const staged = result.value.mediaPathOffloadPaths[0]!;
        const file = result.value.mediaPathOffloadWorkspaceDir
          ? path.join(result.value.mediaPathOffloadWorkspaceDir, staged)
          : staged;
        expect(await fs.readFile(file, "utf8")).toBe(bytes);
        paths.push(file);
        if (mode === "all") {
          expect(file.startsWith(state.path("sandboxes"))).toBe(true);
        }
      }
      expect(paths[0]).not.toBe(paths[1]);
    });
  },
);
