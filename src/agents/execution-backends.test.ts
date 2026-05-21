import { describe, expect, it } from "vitest";
import { resolveAgentExecutionPlacement } from "./execution-backends.js";

describe("agent execution placement", () => {
  it("defaults to the built-in local process backend", () => {
    expect(resolveAgentExecutionPlacement({ cfg: {} })).toEqual({
      ok: true,
      execution: {
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
      execution: {
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
      error: 'unknown execution backend "missing"',
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

  it("accepts future backend config but rejects non-process execution at spawn time", () => {
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
      error:
        'execution backend "k8s" has type "kubernetes", but only local process execution is supported in this release',
    });
  });
});
