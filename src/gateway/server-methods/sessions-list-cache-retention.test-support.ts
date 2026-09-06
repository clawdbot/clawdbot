import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { bumpSessionAutomationVersion } from "../session-automation-index.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";
import type { GatewayRequestContext } from "./types.js";

function requireGc() {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  return gc;
}

const gc = requireGc();

function result(key: string, hasActiveRun = false): SessionsListResult {
  return {
    ts: 1,
    path: "synthetic",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", updatedAt: 1, hasActiveRun }],
  };
}

async function retainedAfterRotation(rotation: "fence" | "config" | "catalog" | "expiry") {
  const context = {} as GatewayRequestContext;
  let config: OpenClawConfig = {};
  const retired: WeakRef<SessionsListResult>[] = [];
  const control = new WeakRef(result("uncached"));
  const modelCatalog = new Map([["main", { entries: [] }]]);
  const readNow = Date.now;
  const expiresAt = readNow() + 60_000;
  const currentKeyOnly = rotation === "catalog" || rotation === "expiry";
  const request = async (offset: number, run: () => Promise<SessionsListResult>) => {
    let response: unknown;
    await respondWithCachedSessionList({
      context,
      config,
      client: null,
      modelCatalog,
      request: { offset, limit: 1 },
      run,
      respond: (ok, payload) => {
        assert.equal(ok, true);
        response = payload;
      },
    });
    return response;
  };
  for (const offset of [0, 1]) {
    await request(offset, async () => {
      const page = result(`cached-${offset}`);
      if (rotation === "expiry") {
        page.sessions[0]!.agentStatus = { note: "Temporary status", expiresAt };
      }
      if (!currentKeyOnly || offset === 0) {
        retired.push(new WeakRef(page));
      }
      return page;
    });
  }
  const started = createDeferredCore();
  const release = createDeferredCore();
  const pending = request(2, async () => {
    started.resolve();
    await release.promise;
    return result("original-caller");
  });
  const refreshStarted = createDeferredCore();
  const releaseRefresh = createDeferredCore();
  let refresh: Promise<unknown> | undefined;
  const collect = async () => {
    // Dereferencing during collection would itself keep pages alive for that job.
    for (let pass = 0; pass < 8; pass += 1) {
      await setImmediate();
      gc();
    }
    assert.equal(control.deref(), undefined, "The uncached control must be collected");
    return retired.flatMap((reference, index) => (reference.deref() ? [index] : []));
  };
  try {
    await started.promise;
    if (rotation === "fence") {
      bumpSessionAutomationVersion();
    } else if (rotation === "config") {
      config = {};
    } else if (rotation === "catalog") {
      modelCatalog.set("main", { entries: [] });
    } else {
      Date.now = () => expiresAt;
    }
    refresh = request(currentKeyOnly ? 0 : 3, async () => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return result("current", true);
    });
    await refreshStarted.promise;
    // An old in-flight call keeps its state alive. It must not also keep pages
    // that no request can reuse, including while an invalid-page refresh awaits.
    const whileRefreshing = await collect();
    releaseRefresh.resolve();
    await refresh;
    return { whileRefreshing, afterActiveResult: await collect() };
  } finally {
    Date.now = readNow;
    releaseRefresh.resolve();
    release.resolve();
    await refresh;
    assert.deepEqual(await pending, result("original-caller"));
  }
}

process.stdout.write(
  JSON.stringify({
    fence: await retainedAfterRotation("fence"),
    config: await retainedAfterRotation("config"),
    catalog: await retainedAfterRotation("catalog"),
    expiry: await retainedAfterRotation("expiry"),
  }),
);
