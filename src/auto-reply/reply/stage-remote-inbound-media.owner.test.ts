import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mediaRoots from "../../media/channel-inbound-roots.js";
import * as processExec from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { agentId: "main", remoteMediaMode: "sandbox-or-cache" },
  { agentId: "work", remoteMediaMode: "sandbox-or-cache" },
  { agentId: undefined, remoteMediaMode: "cache" },
] as const)(
  "stages remote global media for $agentId in $remoteMediaMode mode",
  async ({ agentId, remoteMediaMode }) => {
    await withOpenClawTestState({ label: "remote-media-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: {} },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "all" as const,
              scope: "agent" as const,
              workspaceRoot: state.path("sandbox"),
              workspaceAccess: "none" as const,
            },
          },
        },
        session: { scope: "global" as const },
      };
      vi.spyOn(mediaRoots, "resolveChannelRemoteInboundAttachmentRoots").mockReturnValue([
        "/synthetic/attachments",
      ]);
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
        await fs.writeFile(argv.at(-1)!, "remote attachment");
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const ctx = {
        MediaRemoteHost: "user@gateway-host",
        media: [{ path: "/synthetic/attachments/report.txt" }],
      };
      expect(
        await stageRemoteInboundMediaIfNeeded({
          ctx,
          cfg,
          agentId,
          sessionKey: "global",
          workspaceDir: state.path(`${agentId}-workspace`),
          remoteMediaMode,
        }),
      ).toBe(true);
      const fact = ctx.media[0] as { path: string; workspaceDir?: string; staged?: boolean };
      expect(fact.staged).toBe(true);
      const staged = path.isAbsolute(fact.path)
        ? fact.path
        : path.join(fact.workspaceDir!, fact.path);
      try {
        expect(await fs.readFile(staged, "utf8")).toBe("remote attachment");
        if (remoteMediaMode === "cache") {
          expect(fact.workspaceDir).toContain(path.join("media", "remote-cache"));
          expect(path.isAbsolute(fact.path)).toBe(true);
        } else {
          expect(fact.workspaceDir?.startsWith(state.path("sandbox"))).toBe(true);
          expect(path.isAbsolute(fact.path)).toBe(false);
        }
        expect(
          await stageRemoteInboundMediaIfNeeded({
            ctx,
            cfg,
            agentId,
            sessionKey: "global",
            workspaceDir: state.workspaceDir,
            remoteMediaMode,
          }),
        ).toBe(false);
      } finally {
        // Cache mode uses the test harness's process root; remove only this call's input directory.
        if (remoteMediaMode === "cache") {
          await fs.rm(path.dirname(staged), { recursive: true, force: true });
        }
      }
    });
  },
);
