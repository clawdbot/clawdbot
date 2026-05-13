import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig } from "../config/types.tools.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runLinkUnderstanding } from "./runner.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

function cfg(entry: LinkModelConfig) {
  return {
    tools: {
      links: {
        enabled: true,
        models: [entry],
      },
    },
  } as OpenClawConfig;
}

function ctx(body: string): MsgContext {
  return { Body: body } as MsgContext;
}

function mockGuardedFetch(body = "guarded content", finalUrl = "https://example.com/final") {
  const release = vi.fn(async () => {});
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body),
    finalUrl,
    release,
  });
  return release;
}

function mockCommand(stdout = "summary") {
  mocks.runCommandWithTimeout.mockResolvedValueOnce({
    code: 0,
    killed: false,
    signal: null,
    stderr: "",
    stdout,
    termination: "exit",
  });
}

describe("runLinkUnderstanding", () => {
  beforeEach(() => {
    mocks.fetchWithSsrFGuard.mockReset();
    mocks.runCommandWithTimeout.mockReset();
  });

  it("fetches links through the SSRF guard before passing content to CLI stdin", async () => {
    const release = mockGuardedFetch("page body", "https://example.com/final");
    mockCommand("summarized page");

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize", args: ["--source", "{{LinkUrl}}"] }),
      ctx: ctx("see https://example.com/page"),
    });

    expect(result.outputs).toEqual(["summarized page"]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "link-understanding",
        mode: "strict",
        url: "https://example.com/page",
      }),
    );
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["summarize", "--source"], {
      env: {
        OPENCLAW_LINK_FINAL_URL: "https://example.com/final",
        OPENCLAW_LINK_URL: "https://example.com/page",
      },
      input: "page body",
      timeoutMs: 30000,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not run configured curl fetchers against attacker-controlled URLs", async () => {
    mockGuardedFetch("guarded page body");

    const result = await runLinkUnderstanding({
      cfg: cfg({
        type: "cli",
        command: "curl",
        args: ["-s", "-L", "{{LinkUrl}}"],
      }),
      ctx: ctx("see http://192.168.1.64.nip.io:8888/aws-iam-credentials"),
    });

    expect(result.outputs).toEqual(["guarded page body"]);
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("skips links rejected by the guarded fetch DNS policy", async () => {
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal/special-use IP address"),
    );

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see http://169.254.169.254.nip.io/latest/meta-data/"),
    });

    expect(result.outputs).toEqual([]);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("skips links rejected by the guarded fetch redirect policy", async () => {
    mocks.fetchWithSsrFGuard.mockRejectedValueOnce(
      new Error("redirect target resolves to private network"),
    );

    const result = await runLinkUnderstanding({
      cfg: cfg({ type: "cli", command: "summarize" }),
      ctx: ctx("see https://public.example/redirect-to-metadata"),
    });

    expect(result.outputs).toEqual([]);
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
