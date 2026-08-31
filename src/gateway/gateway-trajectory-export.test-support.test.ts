import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  addSession,
  deleteSession,
  hasActiveBackgroundExecSession,
  markExited,
  waitForExecScope,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createTrajectoryExportFixture,
  settleTrajectoryExportWork,
} from "./gateway-trajectory-export.test-support.js";

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errorTree)] : [error];
}

describe("trajectory fixture cleanup", () => {
  it.each(["settlement", "deadline", "client", "gateway"] as const)(
    "retains evidence and closes remaining owners after %s failure",
    async (failure) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const fixture = await createTrajectoryExportFixture();
      const evidence = path.join(fixture.tempDir, "evidence.txt");
      const bodyError = new Error("trajectory assertion failed");
      const cleanupError = new Error(`${failure} failed`);
      const phases: string[] = [];
      // Real local transport handles prove the fixture releases resources; no model is involved.
      const listener = net.createServer();
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const address = listener.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP listener");
      }
      const accepted = new Promise<net.Socket>((resolve) => {
        listener.once("connection", resolve);
      });
      const socket = net.createConnection(address.port, "127.0.0.1");
      const peer = await accepted;
      await fs.writeFile(evidence, "retained trajectory evidence");
      setTestEnvValue("OPENCLAW_STATE_DIR", fixture.tempDir);
      const pendingExec =
        failure === "deadline"
          ? createProcessSessionFixture({
              id: "trajectory-deadline-exec",
              cwd: fixture.tempDir,
              command: "fixture-command",
              backgrounded: true,
            })
          : undefined;
      if (pendingExec) {
        pendingExec.scopeKey = "trajectory-cleanup-regression";
        addSession(pendingExec);
      }
      fixture.settleOwnedWork = async () => {
        phases.push("settle");
        if (failure === "deadline" || failure === "settlement") {
          await settleTrajectoryExportWork({
            client: {
              request: async () => {
                throw cleanupError;
              },
            },
            deadline: Date.now() + (failure === "deadline" ? -1 : 5_000),
            execScope: "trajectory-cleanup-regression",
            workspaceDir: fixture.tempDir,
            command: "fixture-command",
            runIds: ["fixture-run"],
            sessionKey: "agent:dev:trajectory-cleanup-regression",
          });
        }
      };
      fixture.client = {
        async stopAndWait() {
          phases.push("client");
          const closed = once(socket, "close");
          socket.end();
          await closed;
          if (failure === "client") {
            throw cleanupError;
          }
        },
      };
      fixture.server = {
        async close() {
          phases.push("gateway");
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
          });
          if (failure === "gateway") {
            throw cleanupError;
          }
        },
      };
      try {
        const result: unknown = await runQaGatewayFixture(async () => {
          throw bodyError;
        }, fixture.cleanup).catch((error: unknown) => error);
        expect(phases).toEqual(["settle", "client", "gateway"]);
        expect(socket.destroyed).toBe(true);
        expect(listener.listening).toBe(false);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(await fs.readFile(evidence, "utf8")).toBe("retained trajectory evidence");
        const errors = errorTree(result);
        expect(errors).toContain(bodyError);
        if (failure === "deadline") {
          expect(hasActiveBackgroundExecSession("trajectory-deadline-exec")).toBe(true);
          expect(errors).toContainEqual(new Error("trajectory completion deadline exceeded"));
        }
        expect(errors).toContain(cleanupError);
        expect(
          errors.some((error) => error instanceof Error && error.message.includes(fixture.tempDir)),
        ).toBe(true);
      } finally {
        if (pendingExec) {
          markExited(pendingExec, null, null, "killed");
          await waitForExecScope("trajectory-cleanup-regression");
          deleteSession(pendingExec.id);
        }
        socket.destroy();
        peer.destroy();
        if (listener.listening) {
          await new Promise<void>((resolve) => {
            listener.close(() => resolve());
          });
        }
        // The regression owns these fault-injection resources and has now joined them.
        if (previousStateDir === undefined) {
          deleteTestEnvValue("OPENCLAW_STATE_DIR");
        } else {
          setTestEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
        }
        await fs.rm(fixture.tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "removes settled fixture state (resources acquired: %s)",
    async (acquired) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const fixture = await createTrajectoryExportFixture();
      setTestEnvValue("OPENCLAW_STATE_DIR", fixture.tempDir);
      const phases: string[] = [];
      if (acquired) {
        fixture.settleOwnedWork = async () => {
          phases.push("settle");
        };
        fixture.client = {
          stopAndWait: async () => {
            phases.push("client");
          },
        };
        fixture.server = {
          close: async () => {
            phases.push("gateway");
          },
        };
      }
      await fixture.cleanup();
      expect(phases).toEqual(acquired ? ["settle", "client", "gateway"] : []);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
      await expect(fs.stat(fixture.tempDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
