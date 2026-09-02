// npm publish plan tests validate package publish planning rules.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  fetchNpmRegistryPackumentWithRetry,
  fetchNpmRegistryTarballWithRetry,
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  resolvePublishedNpmVersionRoute,
  shouldRequireNpmDistTagMirrorAuth,
} from "../scripts/lib/npm-publish-plan.mjs";

function registryResponse(params: {
  status?: number;
  body?: string;
  bodyError?: Error;
  cancel?: () => void;
}): Response {
  const status = params.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      cancel: async () => {
        params.cancel?.();
      },
    },
    text: async () => {
      if (params.bodyError) {
        throw params.bodyError;
      }
      return params.body ?? "{}";
    },
  } as unknown as Response;
}

describe("fetchNpmRegistryPackumentWithRetry", () => {
  it("retries a failed response body before returning the parsed packument", async () => {
    const waits: number[] = [];
    let fetchCalls = 0;
    let cancelCalls = 0;
    const packument = { versions: { "2026.7.1-beta.3": {} } };

    const result = await fetchNpmRegistryPackumentWithRetry({
      packageName: "@openclaw/meta-provider",
      packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
      fetchImpl: async () => {
        fetchCalls += 1;
        return registryResponse(
          fetchCalls === 1
            ? {
                bodyError: new TypeError("terminated"),
                cancel: () => {
                  cancelCalls += 1;
                },
              }
            : { body: JSON.stringify(packument) },
        );
      },
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      createSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ status: 200, ok: true, packument });
    expect(fetchCalls).toBe(2);
    expect(cancelCalls).toBe(1);
    expect(waits).toEqual([1000]);
  });

  it("keeps response body failures within the bounded retry budget", async () => {
    const waits: number[] = [];
    let fetchCalls = 0;
    let cancelCalls = 0;

    await expect(
      fetchNpmRegistryPackumentWithRetry({
        packageName: "@openclaw/meta-provider",
        packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
        fetchImpl: async () => {
          fetchCalls += 1;
          return registryResponse({
            bodyError: new DOMException("timed out", "AbortError"),
            cancel: () => {
              cancelCalls += 1;
            },
          });
        },
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
        createSignal: () => new AbortController().signal,
      }),
    ).rejects.toThrow("npm publication-route probe did not return a stable response");

    expect(fetchCalls).toBe(3);
    expect(cancelCalls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("retries malformed JSON before returning the parsed packument", async () => {
    let fetchCalls = 0;
    let cancelCalls = 0;
    const waits: number[] = [];
    const packument = { versions: { "2026.7.1-beta.3": {} } };

    const result = await fetchNpmRegistryPackumentWithRetry({
      packageName: "@openclaw/meta-provider",
      packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
      fetchImpl: async () => {
        fetchCalls += 1;
        return registryResponse(
          fetchCalls === 1
            ? {
                body: "{",
                cancel: () => {
                  cancelCalls += 1;
                },
              }
            : { body: JSON.stringify(packument) },
        );
      },
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      createSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ status: 200, ok: true, packument });
    expect(fetchCalls).toBe(2);
    expect(cancelCalls).toBe(1);
    expect(waits).toEqual([1000]);
  });

  it("keeps malformed JSON within the bounded retry budget", async () => {
    let fetchCalls = 0;
    let cancelCalls = 0;
    const waits: number[] = [];

    await expect(
      fetchNpmRegistryPackumentWithRetry({
        packageName: "@openclaw/meta-provider",
        packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
        fetchImpl: async () => {
          fetchCalls += 1;
          return registryResponse({
            body: "{",
            cancel: () => {
              cancelCalls += 1;
            },
          });
        },
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
        createSignal: () => new AbortController().signal,
      }),
    ).rejects.toThrow("npm publication-route probe returned invalid JSON");

    expect(fetchCalls).toBe(3);
    expect(cancelCalls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("returns a stable missing-package status without retrying", async () => {
    let fetchCalls = 0;
    let cancelCalls = 0;

    const result = await fetchNpmRegistryPackumentWithRetry({
      packageName: "@openclaw/meta-provider",
      packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
      fetchImpl: async () => {
        fetchCalls += 1;
        return registryResponse({
          status: 404,
          cancel: () => {
            cancelCalls += 1;
          },
        });
      },
      sleep: async () => {
        throw new Error("stable 404 must not sleep");
      },
      createSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ status: 404, ok: false, packument: null });
    expect(fetchCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });
});

describe("fetchNpmRegistryTarballWithRetry", () => {
  const packageName = "@openclaw/fixture";
  const packageUrl = "https://registry.npmjs.org/@openclaw/fixture/-/fixture.tgz";
  const bytes = Buffer.from("qualified package bytes");

  it.each([503, 429, "interrupted-body"] as const)(
    "recovers %s using only the original tarball URL",
    async (failure) => {
      const requests: string[] = [];
      const waits: number[] = [];
      let canceled = 0;
      const result = await fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl,
        maxBytes: bytes.length,
        fetchImpl: async (url) => {
          requests.push(url);
          if (requests.length !== 1) {
            return new Response(bytes);
          }
          if (failure === "interrupted-body") {
            let firstChunk = true;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (firstChunk) {
                    firstChunk = false;
                    controller.enqueue(bytes.subarray(0, 3));
                  } else {
                    controller.error(new TypeError("terminated"));
                  }
                },
              }),
            );
          }
          return new Response(
            new ReadableStream({
              cancel() {
                canceled += 1;
              },
            }),
            {
              status: failure,
              headers: failure === 429 ? { "retry-after": "2" } : {},
            },
          );
        },
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });
      expect(result).toEqual(bytes);
      expect(requests).toEqual([packageUrl, packageUrl]);
      expect(waits).toEqual([failure === 429 ? 2000 : 1000]);
      if (typeof failure === "number") {
        expect(canceled).toBe(1);
      }
    },
  );

  it.each([401, 403, 404, 410, 302])(
    "does not retry or follow permanent HTTP %s responses",
    async (status) => {
      let requests = 0;
      let canceled = 0;
      await expect(
        fetchNpmRegistryTarballWithRetry({
          packageName,
          packageUrl,
          maxBytes: bytes.length,
          fetchImpl: async () => {
            requests += 1;
            return new Response(
              new ReadableStream({
                cancel() {
                  canceled += 1;
                },
              }),
              {
                status,
                headers: { location: "https://other.example/package.tgz" },
              },
            );
          },
          sleep: async () => {
            throw new Error("permanent responses must not retry");
          },
        }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(requests).toBe(1);
      expect(canceled).toBe(1);
    },
  );

  it.each(["header", "stream"])("rejects oversized %s bytes without retry", async (kind) => {
    let requests = 0;
    await expect(
      fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl,
        maxBytes: bytes.length,
        fetchImpl: async () => {
          requests += 1;
          return new Response(Buffer.concat([bytes, Buffer.from("extra")]), {
            headers: kind === "header" ? { "content-length": String(bytes.length + 5) } : {},
          });
        },
        sleep: async () => {
          throw new Error("oversized bytes must not retry");
        },
      }),
    ).rejects.toMatchObject({ code: "ETOOBIG" });
    expect(requests).toBe(1);
  });

  it.each(["seconds", "date"])(
    "does not violate Retry-After %s to fit its deadline",
    async (kind) => {
      const retryAfter = kind === "seconds" ? "60" : new Date(Date.now() + 60_000).toUTCString();
      let requests = 0;
      await expect(
        fetchNpmRegistryTarballWithRetry({
          packageName,
          packageUrl,
          maxBytes: bytes.length,
          deadlineMs: Date.now() + 1000,
          fetchImpl: async () => {
            requests += 1;
            return new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            });
          },
          sleep: async () => {
            throw new Error("deadline must fail before sleeping");
          },
        }),
      ).rejects.toThrow("deadline would be exceeded before the permitted retry");
      expect(requests).toBe(1);
    },
  );

  it("recovers a real HTTP disconnect within the shared GET retry budget", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503).end("temporarily unavailable");
      } else if (requests === 2) {
        response.writeHead(200, { "content-length": String(bytes.length) });
        response.write(bytes.subarray(0, 3));
        setImmediate(() => response.destroy());
      } else {
        response.end(bytes);
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      const result = await fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl: `http://127.0.0.1:${address.port}/fixture.tgz`,
        maxBytes: bytes.length,
        timeoutMs: 1000,
        sleep: async () => {},
      });
      expect(result).toEqual(bytes);
      expect(requests).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("resolvePublishedNpmVersionRoute", () => {
  it.each([
    {
      label: "missing beta",
      version: "2026.7.1-beta.3",
      distTags: {},
    },
    {
      label: "lagging beta",
      version: "2026.7.1-beta.3",
      distTags: { beta: "2026.7.1-beta.2" },
    },
    {
      label: "lagging alpha",
      version: "2026.7.1-alpha.3",
      distTags: { alpha: "2026.7.1-alpha.2" },
    },
    {
      label: "lagging latest with a current beta mirror",
      version: "2026.7.1",
      distTags: { latest: "2026.6.11", beta: "2026.7.1" },
    },
  ])(
    "requires tag repair when the primary $label selector is repairable",
    ({ version, distTags }) => {
      expect(
        resolvePublishedNpmVersionRoute({
          packageVersion: version,
          publishPlan: resolveNpmPublishPlan(version),
          distTags,
        }),
      ).toBe("npm-tag-repair");
    },
  );

  it.each([
    ["ahead beta", "2026.7.1-beta.3", { beta: "2026.7.1-beta.4" }],
    ["ahead alpha", "2026.7.1-alpha.3", { alpha: "2026.7.1-alpha.4" }],
    ["ahead latest", "2026.7.1", { latest: "2026.8.1" }],
    ["incomparable beta", "2026.7.1-beta.3", { beta: "not-a-version" }],
    ["conflicting beta", "2026.7.1-beta.3", { beta: " 2026.7.1-beta.3 " }],
  ])("rejects an unsafe primary %s selector", (_label, version, distTags) => {
    expect(() =>
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags,
      }),
    ).toThrow("cannot be safely moved");
  });

  it("requires mirror repair only after the primary selector matches", () => {
    const version = "2026.7.1";
    expect(
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags: { latest: version, beta: "2026.7.1-beta.3" },
      }),
    ).toBe("npm-mirror");
  });

  it("rejects an incomparable mirror instead of advertising repair", () => {
    const version = "2026.7.1";
    expect(() =>
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags: { latest: version, beta: "not-a-version" },
      }),
    ).toThrow("cannot be safely moved");
  });

  it("validates unsafe mirrors before returning primary tag repair", () => {
    const version = "2026.7.1";
    expect(() =>
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags: { latest: "2026.6.11", beta: "not-a-version" },
      }),
    ).toThrow("cannot be safely moved");
  });

  it("rejects an ahead mirror from an inconsistent publish plan", () => {
    const version = "2026.7.1";
    expect(() =>
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags: { latest: version, beta: "2026.8.1-beta.1" },
      }),
    ).toThrow("cannot be safely moved");
  });

  it("preserves an ahead beta selector when the publish plan omits the mirror", () => {
    const version = "2026.7.1";
    expect(
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version, "2026.8.1-beta.1"),
        distTags: { latest: version, beta: "2026.8.1-beta.1" },
      }),
    ).toBe("npm-readback");
  });

  it.each([
    ["beta", "2026.7.1-beta.3", { beta: "2026.7.1-beta.3" }],
    ["alpha", "2026.7.1-alpha.3", { alpha: "2026.7.1-alpha.3" }],
    ["stable", "2026.7.1", { latest: "2026.7.1", beta: "2026.7.1" }],
  ])("accepts complete %s registry readback", (_label, version, distTags) => {
    expect(
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags,
      }),
    ).toBe("npm-readback");
  });
});

describe("shouldRequireNpmDistTagMirrorAuth", () => {
  it("does not require npm auth for dry-run preview commands", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--dry-run",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("requires npm auth for real publishes that mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(true);
  });

  it("treats stable correction releases as latest publishes with beta mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-1");

    expect(plan).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
  });

  it("does not require auth when there are no mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-beta.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("publishes alpha prereleases without dist-tag mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-alpha.1");

    expect(plan).toEqual({
      channel: "alpha",
      publishTag: "alpha",
      mirrorDistTags: [],
    });
  });

  it("does not require auth when a publish already has npm auth", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({ npmToken: "token" });

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });
});

describe("extended-stable npm publish override", () => {
  it("publishes final patch 33 and later to extended-stable without mirrors", () => {
    expect(resolveNpmPublishPlan("2026.7.33", undefined, "extended-stable")).toEqual({
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    });
    expect(resolveNpmPublishPlan("2026.7.34", "2026.8.1-beta.1", "extended-stable")).toEqual({
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    });
  });

  it.each([
    ["pre-.33 final", "2026.7.32", "extended-stable"],
    ["correction", "2026.7.33-1", "extended-stable"],
    ["alpha", "2026.7.33-alpha.1", "extended-stable"],
    ["beta", "2026.7.33-beta.1", "extended-stable"],
    ["open override", "2026.7.33", "latest"],
  ])("rejects %s releases", (_label, version, override) => {
    expect(() => resolveNpmPublishPlan(version, undefined, override)).toThrow();
  });
});
