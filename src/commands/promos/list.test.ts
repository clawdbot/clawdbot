import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  fetchClawHubPromotions: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/clawhub.js")>("../../infra/clawhub.js");
  return {
    ...actual,
    fetchClawHubPromotions: mocks.fetchClawHubPromotions,
  };
});

const { ClawHubRequestError } = await import("../../infra/clawhub.js");
const { promosListCommand } = await import("./list.js");

function makeRuntime() {
  const lines: string[] = [];
  const stdout: string[] = [];
  const writeStdout = vi.fn((value: string): void => {
    stdout.push(value);
  });
  const runtime: OutputRuntimeEnv = {
    log: vi.fn((...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    }),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout,
    writeJson: vi.fn((value: unknown, space = 2) => {
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
  };
  return { runtime, lines, stdout };
}

const promotion = {
  slug: "spring-models",
  title: "Free Example models",
  blurb: "A limited-time offer.",
  sponsor: "Example",
  status: "active",
  active: true,
  startsAt: Date.now() - 1_000,
  endsAt: Date.now() + 3 * 86_400_000,
  provider: "openrouter",
  models: [
    { modelRef: "openrouter/example/model-alpha", alias: "Model Alpha", suggestedDefault: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promosListCommand", () => {
  it("prints promotions with models and the claim command", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([promotion]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    const output = lines.join("\n");
    expect(output).toContain("Free Example models — Example");
    expect(output).toContain("openrouter/example/model-alpha (Model Alpha) — suggested default");
    expect(output).toContain("openclaw promos claim spring-models");
  });

  it("prints an empty-state line when nothing is live", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    expect(lines.join("\n")).toContain("No active promotions");
  });

  it("reports a friendly unavailable state when the promotions route is not deployed", async () => {
    mocks.fetchClawHubPromotions.mockRejectedValue(
      new ClawHubRequestError({ path: "/api/v1/promotions", status: 404, body: "not found" }),
    );
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    expect(lines).toEqual(["Promotions are not available from ClawHub yet."]);
  });

  it("preserves the JSON shape when the promotions route is not deployed", async () => {
    mocks.fetchClawHubPromotions.mockRejectedValue(
      new ClawHubRequestError({ path: "/api/v1/promotions", status: 404, body: "not found" }),
    );
    const { runtime, lines, stdout } = makeRuntime();

    await promosListCommand({ json: true }, runtime);

    expect(lines).toEqual([]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.writeStdout).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.join(""))).toEqual({ promotions: [] });
  });

  it("strips terminal control sequences from remote promotion text", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([
      {
        ...promotion,
        title: "Free\u001b[31m models",
        blurb: "Offer\u001b]0;pwned\u0007 text",
      },
    ]);
    const { runtime, lines } = makeRuntime();

    await promosListCommand({}, runtime);

    const output = lines.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("Free");
  });

  it("writes JSON to stdout with --json", async () => {
    mocks.fetchClawHubPromotions.mockResolvedValue([promotion]);
    const { runtime, lines, stdout } = makeRuntime();

    await promosListCommand({ json: true }, runtime);

    expect(lines).toEqual([]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.writeStdout).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdout.join("")) as { promotions: Array<{ slug: string }> };
    expect(parsed.promotions[0]?.slug).toBe("spring-models");
  });
});
