// Doctor cron delivery-target advisory tests cover concrete-vs-pseudo channel detection.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  note: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => {
  vi.clearAllMocks();
});

const STORE_PATH = "/tmp/openclaw/cron/jobs.sqlite";

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "job", schedule: "0 * * * *", ...overrides };
}

/** Resolver thunk returning a fixed channel set; tracks whether it was invoked. */
function availableChannels(...ids: string[]) {
  return vi.fn(() => ids);
}

function collectCronDeliveryTargetAdvisory(params: {
  jobs: Array<Record<string, unknown>>;
  storePath: string;
  resolveAvailableChannelIds: () => string[];
}): string | null {
  mocks.note.mockClear();
  mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() =>
    params.resolveAvailableChannelIds().map((id) => ({ id })),
  );
  noteCronDeliveryTargetAdvisory({
    cfg: {},
    jobs: params.jobs,
    storePath: params.storePath,
  });
  const body = mocks.note.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : null;
}

describe("collectCronDeliveryTargetAdvisory", () => {
  it("advises when a concrete delivery channel has no active plugin", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "report", delivery: { mode: "announce", channel: "missing-channel" } })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels("slack", "telegram"),
    });
    expect(advisory).not.toBeNull();
    expect(advisory).toContain("Cron delivery targets unavailable channels");
    expect(advisory).toContain("1 job announces");
    expect(advisory).toContain("Channels: missing-channel=1");
    expect(advisory).toContain("Examples: report -> missing-channel");
  });

  it("returns null when the concrete channel resolves to an active plugin", () => {
    // Omitting `mode` defaults to announce, so a bare channel still counts as a concrete target.
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery: { channel: "slack" } })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels("slack", "telegram"),
    });
    expect(advisory).toBeNull();
  });

  it("treats a channel alias as active when its canonical id is available", () => {
    // "gchat" canonicalizes to "googlechat"; an alias target must not look unavailable.
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery: { mode: "announce", channel: "gchat" } })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels("googlechat"),
    });
    expect(advisory).toBeNull();
  });

  it.each([
    ["announce-to-last", { mode: "announce", channel: "last" }],
    ["webhook", { mode: "webhook", to: "https://example.invalid/hook" }],
    ["none with a channel", { mode: "none", channel: "missing-channel" }],
  ])("skips pseudo/relative target: %s", (_label, delivery) => {
    const resolve = availableChannels("slack");
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
  });

  it("does not resolve channels when no job pins a concrete target", () => {
    // Resolution is lazy: a job without an explicit delivery object never triggers the snapshot.
    const resolve = vi.fn(() => {
      throw new Error("channel resolution should not run");
    });
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "implicit" }), job({ id: "weblike", delivery: { mode: "webhook" } })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips disabled jobs because they have no next scheduled delivery", () => {
    const resolve = availableChannels("slack");
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({
          enabled: false,
          delivery: { mode: "announce", channel: "missing-channel" },
        }),
      ],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("flags a concrete target even when no channels are active (only channel removed)", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "report", delivery: { mode: "announce", channel: "slack" } })],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels(),
    });
    expect(advisory).toContain("Channels: slack=1");
  });

  it("aggregates counts and caps examples at three", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({ id: "ok", delivery: { mode: "announce", channel: "slack" } }),
        job({ id: "g1", delivery: { mode: "announce", channel: "ghost-a" } }),
        job({ id: "g2", delivery: { mode: "announce", channel: "ghost-a" } }),
        job({ id: "g3", delivery: { mode: "announce", channel: "ghost-b" } }),
        job({ id: "g4", delivery: { mode: "announce", channel: "ghost-b" } }),
      ],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels("slack"),
    });
    expect(advisory).toContain("4 jobs announce");
    // Channels render sorted by id.
    expect(advisory).toContain("Channels: ghost-a=2, ghost-b=2");
    const exampleLine = advisory?.split("\n").find((line) => line.startsWith("- Examples:"));
    expect(exampleLine).toBeDefined();
    expect(exampleLine?.split(" -> ").length).toBe(4); // three "<id> -> <channel>" pairs
    expect(advisory).not.toContain("g4 -> ghost-b");
  });

  it("falls back to job name then <unnamed> in examples", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({
          id: undefined,
          name: "Nightly digest",
          delivery: { mode: "announce", channel: "ghost" },
        }),
        job({ id: undefined, name: undefined, delivery: { mode: "announce", channel: "ghost" } }),
      ],
      storePath: STORE_PATH,
      resolveAvailableChannelIds: availableChannels("slack"),
    });
    expect(advisory).toContain("Nightly digest -> ghost");
    expect(advisory).toContain("<unnamed> -> ghost");
  });
});

describe("collectLegacyWhatsAppCrontabHealthWarning", () => {
  it("bounds the best-effort crontab read", async () => {
    mocks.runExec.mockRejectedValueOnce(new Error("crontab timed out"));

    await expect(
      collectLegacyWhatsAppCrontabHealthWarning({ platform: "linux" }),
    ).resolves.toBeNull();
    expect(mocks.runExec).toHaveBeenCalledWith("crontab", ["-l"], {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });
});
