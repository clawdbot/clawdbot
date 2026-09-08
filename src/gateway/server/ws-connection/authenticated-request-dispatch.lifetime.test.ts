import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../../../config/paths.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";

afterEach(() => {
  vi.doUnmock("./authenticated-request-dispatch.server-methods.runtime.js");
  vi.doUnmock("./request-start.js");
  vi.resetModules();
});

describe("authenticated request completion", { concurrent: false }, () => {
  it.for([
    "lazy import",
    "start scheduler",
    "profile authorization",
    "handler after response",
  ] as const)(
    "joins %s before its caller can restore state selection",
    async (stage, { signal }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const initialRoot = path.join(os.tmpdir(), "dispatch-lifetime", "fixture");
      const restoredRoot = path.join(os.tmpdir(), "dispatch-lifetime", "restored");
      // Exercise late path selection without opening a store or changing process selectors.
      const selection = { OPENCLAW_STATE_DIR: initialRoot };
      let selectedRoot: string | undefined;
      let dispatched = false;
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const handleGatewayRequest = async (options: GatewayRequestOptions) => {
        try {
          options.respond(true, { accepted: true });
          if (stage === "handler after response") {
            await hold();
          }
          selectedRoot = resolveStateDir(selection);
        } finally {
          finished.resolve();
        }
      };
      vi.resetModules();
      if (stage !== "profile authorization") {
        vi.doMock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
          if (stage === "lazy import") {
            await hold();
          }
          return { handleGatewayRequest };
        });
      }
      if (stage === "start scheduler") {
        vi.doMock("./request-start.js", () => ({ scheduleGatewayRequestStart: hold }));
      }
      const { createDispatchTestHarness, createOperatorWsClient } =
        await import("./authenticated-request-dispatch.test-support.js");
      const harness = createDispatchTestHarness({
        extraHandlers: { "test.lifetime": handleGatewayRequest },
        buildRequestContext: () => ({ getRuntimeConfig: () => ({}) }),
      });
      const client = createOperatorWsClient({ socket: new EventEmitter() });
      if (stage === "profile authorization") {
        client.authenticatedGitHubIdentitySync = async () => {
          await hold();
          client.authenticatedUserProfile = {
            profileId: "lifetime-profile",
            displayName: "Lifetime fixture",
            avatarRevision: "lifetime-avatar",
            hasAvatar: false,
            updatedAt: 1,
          };
          return { profileId: "lifetime-profile", updatedAt: 1 };
        };
      }
      const dispatch = harness.dispatcher
        .dispatch({ type: "req", id: "held", method: "test.lifetime", params: {} }, client)
        .then(() => {
          dispatched = true;
          selection.OPENCLAW_STATE_DIR = restoredRoot;
        });
      try {
        await entered.promise;
        await nextTurn();
        expect.soft(dispatched, `${stage} is still executing`).toBe(false);
      } finally {
        // Join the handler independently: the broken dispatcher returns before it finishes.
        unblock();
        await finished.promise;
        await dispatch;
        signal.removeEventListener("abort", unblock);
      }
      expect(selectedRoot).toBe(initialRoot);
      expect(dispatched).toBe(true);
    },
  );
});
