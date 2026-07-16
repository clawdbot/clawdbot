import { describe, expect, it } from "vitest";
import {
  installAgentContractHooks,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  setBrowserControlServerEvaluateEnabled,
  setBrowserControlServerProfiles,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-fetch.js";

type ActErrorResponse = {
  error?: string;
  code?: string;
};

type ActErrorHttpResponse = {
  status: number;
  body: ActErrorResponse;
};

async function postActAndReadError(base: string, body?: unknown): Promise<ActErrorHttpResponse> {
  const realFetch = getBrowserTestFetch();
  const response = await realFetch(`${base}/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ActErrorResponse,
  };
}

describe("browser control server", () => {
  installAgentContractHooks();

  const slowTimeoutMs = process.platform === "win32" ? 40_000 : 20_000;

  it(
    "returns ACT_KIND_REQUIRED when kind is missing",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_KIND_REQUIRED");
      expect(response.body.error).toContain("kind is required");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_INVALID_REQUEST for malformed action payloads",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "click",
        ref: {},
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_INVALID_REQUEST");
      expect(response.body.error).toContain("click requires ref or selector");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_EXISTING_SESSION_UNSUPPORTED for unsupported existing-session actions",
    async () => {
      setBrowserControlServerProfiles({
        openclaw: {
          color: "#FF4500",
          driver: "existing-session",
        },
      });

      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "batch",
        actions: [{ kind: "press", key: "Enter" }],
      });

      expect(response.status).toBe(501);
      expect(response.body.code).toBe("ACT_EXISTING_SESSION_UNSUPPORTED");
      expect(response.body.error).toContain("batch");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_TARGET_ID_MISMATCH for batched action targetId overrides",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "batch",
        actions: [{ kind: "click", ref: "5", targetId: "other-tab" }],
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(response.body.error).toContain("batched action targetId must match request targetId");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_TARGET_ID_MISMATCH for top-level action targetId overrides",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "click",
        ref: "5",
        // Intentionally non-string: route-level target selection ignores this,
        // while action normalization stringifies it.
        targetId: 12345,
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(response.body.error).toContain("action targetId must match request targetId");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_SELECTOR_UNSUPPORTED for selector on unsupported action kinds",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "evaluate",
        fn: "() => 1",
        selector: "#submit",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_SELECTOR_UNSUPPORTED");
      expect(response.body.error).toContain("'selector' is not supported");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_INVALID_REQUEST for malformed unsupported selector actions before selector gating",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "press",
        selector: "#submit",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_INVALID_REQUEST");
      expect(response.body.error).toContain("press requires key");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_EVALUATE_DISABLED when evaluate is blocked by config",
    async () => {
      setBrowserControlServerEvaluateEnabled(false);
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "evaluate",
        fn: "() => 1",
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_EVALUATE_DISABLED");
      expect(response.body.error).toContain("browser.evaluateEnabled=false");
    },
    slowTimeoutMs,
  );
});
