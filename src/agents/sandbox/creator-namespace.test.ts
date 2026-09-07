import { describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hashTextSha256 } from "./hash.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

describe("required sandbox creator namespaces", () => {
  it.each(["agent", "session", "shared"] as const)(
    "separates non-profile resources with configured %s scope",
    async (scope) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const id = "equal-creator-id";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
                scope,
                workspaceAccess: "rw",
                workspaceRoot: state.path("sandboxes"),
              },
            },
          },
        };
        const actors: Array<SessionCreatedActor | undefined> = [
          { type: "human", source: "profile", id },
          { type: "human", source: "channel", id },
          { type: "human", source: "unknown", id },
          { type: "agent", id },
          { type: "system", id },
          { type: "human", source: "unknown" },
          undefined,
        ];
        const layoutFor = (sessionKey: string, classificationSessionKey?: string) => {
          const runtime = resolveSandboxRuntimeStatus({
            cfg,
            sessionKey,
            classificationSessionKey,
          });
          expect(runtime.sessionKey).toBe(sessionKey);
          expect(runtime.classificationSessionKey).toBe(classificationSessionKey ?? sessionKey);
          expect(runtime.sandboxed).toBe(true);
          if (!runtime.sandboxRequired) {
            throw new Error("required sandbox lost its restriction");
          }
          expect(runtime.workspaceAccess).toBe("ro");
          return resolveSandboxWorkspaceLayoutPaths({
            ...runtime,
            cfg: {
              scope,
              workspaceAccess: runtime.workspaceAccess,
              workspaceRoot: state.path("sandboxes"),
            },
            rawSessionKey: sessionKey,
            workspaceDir: state.workspaceDir,
          });
        };
        const scopes = new Set<string>();
        const workspaces = new Set<string>();
        const containers = new Set<string>();
        for (const [index, createdActor] of actors.entries()) {
          const layouts = [];
          for (const suffix of ["one", "two"]) {
            const sessionKey = `agent:main:required-${index}-${suffix}`;
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              {
                sessionId: sessionKey,
                updatedAt: 1,
                createdVia: "cron",
                createdActor,
                sandbox: "required",
              },
            );
            const layout = layoutFor(sessionKey);
            for (const alias of [
              sessionKey.slice("agent:main:".length),
              sessionKey.toUpperCase(),
            ]) {
              expect.soft(layoutFor(alias), alias).toEqual(layout);
              expect.soft(layoutFor("agent:main:borrowed-runtime", alias), alias).toEqual(layout);
            }
            layouts.push(layout);
            scopes.add(layout.scopeKey);
            workspaces.add(layout.workspaceDir);
            containers.add(
              buildSandboxContainerName("openclaw-sbx-", slugifySessionKey(layout.scopeKey)),
            );
          }
          const [first, second] = layouts;
          if (!first || !second) {
            throw new Error("expected two persisted sessions");
          }
          if (index === 0) {
            // This is the existing profile key contract, including its unprefixed principal digest.
            expect(first.scopeKey).toBe(
              `agent:main:principal:${hashTextSha256(id).slice(0, 32)}:workspace:${hashTextSha256(state.workspaceDir).slice(0, 32)}`,
            );
            expect(second).toEqual(first);
          } else {
            expect.soft(first.scopeKey).not.toBe(second.scopeKey);
          }
        }
        expect.soft(scopes.size).toBe(13);
        expect.soft(workspaces.size).toBe(13);
        expect.soft(containers.size).toBe(13);
      });
    },
  );
});
