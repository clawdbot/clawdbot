import { describe, expect, it } from "vitest";
import { resolveAgentExecutionPlacement } from "./execution-backends.js";

describe("agent execution placement", () => {
  it("defaults to the built-in local process backend", () => {
    expect(resolveAgentExecutionPlacement({ cfg: {} })).toEqual({
      ok: true,
      value: {
        backend: "local",
        type: "process",
      },
    });
  });

  it("accepts configured local process profiles", () => {
    expect(
      resolveAgentExecutionPlacement({
        cfg: {
          agents: {
            executionBackends: {
              local: {
                type: "process",
                profiles: {
                  small: { resources: { requests: { cpu: "500m" } } },
                },
              },
            },
          },
        },
        request: { backend: "local", profile: "small" },
      }),
    ).toEqual({
      ok: true,
      value: {
        backend: "local",
        type: "process",
        profile: "small",
      },
    });
  });

  it("rejects unknown backends and profiles", () => {
    expect(
      resolveAgentExecutionPlacement({
        cfg: {},
        request: { backend: "missing" },
      }),
    ).toEqual({
      ok: false,
      error: 'unknown execution backend "missing"; use "local" or configure the backend first',
    });

    expect(
      resolveAgentExecutionPlacement({
        cfg: {
          agents: {
            executionBackends: {
              local: {
                type: "process",
                profiles: {
                  small: {},
                },
              },
            },
          },
        },
        request: { backend: "local", profile: "large" },
      }),
    ).toEqual({
      ok: false,
      error: 'unknown execution profile "large" for backend "local"',
    });
  });

  it("rejects configured non-local backends until dispatch exists", () => {
    expect(
      resolveAgentExecutionPlacement({
        cfg: {
          agents: {
            executionBackends: {
              k8s: {
                type: "kubernetes",
                profiles: {
                  "large-build": {},
                },
              },
            },
          },
        },
        request: { backend: "k8s", profile: "large-build" },
      }),
    ).toEqual({
      ok: false,
      error: 'execution backend "k8s" is not supported until it has a dispatcher',
    });
  });

  it("keeps local process-backed when config overrides its type", () => {
    expect(
      resolveAgentExecutionPlacement({
        cfg: { agents: { executionBackends: { local: { type: "container" } } } },
      }),
    ).toEqual({ ok: true, value: { backend: "local", type: "process" } });
  });

  it("bounds backend identifiers before returning errors", () => {
    const result = resolveAgentExecutionPlacement({
      cfg: {},
      request: { backend: "x".repeat(1024) },
    });
    expect(result).toEqual({
      ok: false,
      error: `unknown execution backend "${"x".repeat(128)}"; use "local" or configure the backend first`,
    });
  });
});
