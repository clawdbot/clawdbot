import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeMeta,
} from "./channel-setup.test-helpers.js";

type ListChatChannels = typeof import("../channels/chat-meta.js").listChatChannels;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type FormatChannelPrimerLine = typeof import("../channels/registry.js").formatChannelPrimerLine;
type FormatChannelSelectionLine =
  typeof import("../channels/registry.js").formatChannelSelectionLine;
type IsChannelConfigured = typeof import("../config/channel-configured.js").isChannelConfigured;
type ChannelSetupStatusModule = typeof import("./channel-setup.status.js");
type NoteChannelPrimerChannels = Parameters<
  typeof import("./channel-setup.status.js").noteChannelPrimer
>[1];

const listChatChannels = vi.hoisted(() => vi.fn<ListChatChannels>(() => []));
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn<ResolveChannelSetupEntries>(() => ({
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
  })),
);
const formatChannelPrimerLine = vi.hoisted(() =>
  vi.fn<FormatChannelPrimerLine>((meta) => `${meta.label}: ${meta.blurb}`),
);
const formatChannelSelectionLine = vi.hoisted(() =>
  vi.fn<FormatChannelSelectionLine>((meta) => `${meta.label} — ${meta.blurb}`),
);
const isChannelConfigured = vi.hoisted(() => vi.fn<IsChannelConfigured>(() => false));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => listChatChannels(),
}));

vi.mock("../channels/registry.js", () => ({
  formatChannelPrimerLine: (meta: Parameters<FormatChannelPrimerLine>[0]) =>
    formatChannelPrimerLine(meta),
  formatChannelSelectionLine: (
    meta: Parameters<FormatChannelSelectionLine>[0],
    docsLink: Parameters<FormatChannelSelectionLine>[1],
  ) => formatChannelSelectionLine(meta, docsLink),
  normalizeAnyChannelId: (channelId?: string) => channelId?.trim().toLowerCase() ?? null,
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: (params: Parameters<ResolveChannelSetupEntries>[0]) =>
    resolveChannelSetupEntries(params),
  shouldShowChannelInSetup: (meta: { exposure?: { setup?: boolean }; showInSetup?: boolean }) =>
    meta.showInSetup !== false && meta.exposure?.setup !== false,
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (
    cfg: Parameters<IsChannelConfigured>[0],
    channelId: Parameters<IsChannelConfigured>[1],
  ) => isChannelConfigured(cfg, channelId),
}));

// Avoid touching the real `extensions/<id>` tree from unit tests. Status
// rendering for installable catalog entries asks `bundled-sources` whether
// a plugin already lives in-tree to decide between
// "install plugin to enable" vs "bundled · enable to use". For these tests
// we want the installable-catalog branch unconditionally, so we stub the
// bundled lookup to "nothing is bundled".
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources: () => new Map(),
  findBundledPluginSourceInMap: () => undefined,
}));

let collectChannelStatus: ChannelSetupStatusModule["collectChannelStatus"];
let noteChannelPrimer: ChannelSetupStatusModule["noteChannelPrimer"];
let resolveChannelSelectionNoteLines: ChannelSetupStatusModule["resolveChannelSelectionNoteLines"];
let resolveChannelSetupSelectionContributions: ChannelSetupStatusModule["resolveChannelSetupSelectionContributions"];

function requireFirstMockCall<const Calls extends readonly unknown[][]>(
  calls: Calls,
  label: string,
): Calls[number] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call as Calls[number];
}

describe("resolveChannelSetupSelectionContributions", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    listChatChannels.mockReturnValue([
      makeMeta("discord", "Discord"),
      makeMeta("imessage", "iMessage"),
    ]);
    resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    formatChannelPrimerLine.mockImplementation(
      (meta: { label: string; blurb: string }) => `${meta.label}: ${meta.blurb}`,
    );
    formatChannelSelectionLine.mockImplementation((meta) => `${meta.label} — ${meta.blurb}`);
    isChannelConfigured.mockReturnValue(false);
    ({
      collectChannelStatus,
      noteChannelPrimer,
      resolveChannelSelectionNoteLines,
      resolveChannelSetupSelectionContributions,
    } = await import("./channel-setup.status.js"));
  });

  it("sorts channels alphabetically by picker label", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
          },
        },
        {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord (Bot API)",
          },
        },
        {
          id: "imessage",
          meta: {
            id: "imessage",
            label: "iMessage",
            selectionLabel: "iMessage (macOS app)",
          },
        },
      ],
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions.map((contribution) => contribution.option.label)).toEqual([
      "Discord (Bot API)",
      "iMessage (macOS app)",
      "Zalo (Bot API)",
    ]);
  });

  it("does not invent hints before status has been collected", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
          },
        },
      ],
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions.map((contribution) => contribution.option)).toEqual([
      {
        value: "zalo",
        label: "Zalo (Bot API)",
      },
    ]);
  });

  it("combines real status and disabled hints when available", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo",
            selectionLabel: "Zalo (Bot API)",
          },
        },
      ],
      statusByChannel: new Map([["zalo", { selectionHint: "configured" }]]),
      resolveDisabledHint: () => "disabled",
    });

    expect(contributions[0]?.option).toEqual({
      value: "zalo",
      label: "Zalo (Bot API)",
      hint: "configured · disabled",
    });
  });

  it("sanitizes picker labels and hints before terminal rendering", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo\u001B[31m\nBot\u0007",
          },
        },
      ],
      statusByChannel: new Map([["zalo", { selectionHint: "configured\u001B[2K\nnow" }]]),
      resolveDisabledHint: () => "disabled\u0007",
    });

    expect(contributions[0]?.option).toEqual({
      value: "zalo",
      label: "Zalo\\nBot",
      hint: "configured\\nnow · disabled",
    });
  });

  it("sanitizes the picker fallback label when metadata sanitizes to empty", () => {
    const contributions = resolveChannelSetupSelectionContributions({
      entries: [
        {
          id: "bad\u001B[31m\nid",
          meta: {
            id: "bad\u001B[31m\nid",
            label: "\u001B[31m\u0007",
          },
        },
      ],
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(contributions[0]?.option).toEqual({
      value: "bad\u001B[31m\nid",
      label: "bad\\nid",
    });
  });

  it("sanitizes channel labels in status note lines", async () => {
    listChatChannels.mockReturnValue([makeMeta("discord", "Discord\u001B[31m\nCore\u0007")]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        installedCatalogEntries: [makeCatalogEntry("matrix", "Matrix\u001B[2K\nPlugin\u0007")],
        installableCatalogEntries: [makeCatalogEntry("zalo", "Zalo\u001B[2K\nPlugin\u0007")],
      }),
    );

    const summary = await collectChannelStatus({
      cfg: {} as never,
      accountOverrides: {},
      installedPlugins: [],
    });

    expect(summary.statusLines).toEqual([
      "Discord\\nCore: not configured",
      "Matrix\\nPlugin: installed",
      "Zalo\\nPlugin: install plugin to enable",
    ]);
  });

  it("sanitizes channel metadata before primer notes", async () => {
    const note = vi.fn(async () => undefined);

    await noteChannelPrimer(
      { note } as never,
      [
        {
          id: "bad\u001B[31m\nid",
          label: "\u001B[31m\u0007",
          blurb: "Blurb\u001B[2K\nline\u0007",
        } satisfies NoteChannelPrimerChannels[number],
      ] as NoteChannelPrimerChannels,
    );

    expect(formatChannelPrimerLine).toHaveBeenCalledOnce();
    const [primerMeta] = requireFirstMockCall(formatChannelPrimerLine.mock.calls, "primer line");
    expect(primerMeta?.id).toBe("bad\\nid");
    expect(primerMeta?.label).toBe("bad\\nid");
    expect(primerMeta?.selectionLabel).toBe("bad\\nid");
    expect(primerMeta?.blurb).toBe("Blurb\\nline");
    expect(note).toHaveBeenCalledWith(
      [
        "Inbound DM safety defaults to pairing: unknown senders get a pairing code first.",
        "Approve with: openclaw pairing approve <channel> <code>",
        'Open/public DMs require dmPolicy="open" plus allowFrom=["*"].',
        'For multi-user DMs, isolate sessions with: openclaw config set session.dmScope "per-channel-peer" (or "per-account-channel-peer" for multi-account channels).',
        "Docs: https://docs.openclaw.ai/channels/pairing",
        "",
        "bad\\nid: Blurb\\nline",
      ].join("\n"),
      "How channels work",
    );
  });

  it("sanitizes channel metadata before selection notes", () => {
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "zalo",
            meta: {
              id: "zalo",
              label: "Zalo\u001B[31m\nBot\u0007",
              selectionLabel: "Zalo",
              docsPath: "/channels/zalo",
              docsLabel: "Docs\u001B[2K\nLabel",
              blurb: "Setup\u001B[2K\nhelp\u0007",
              selectionDocsPrefix: "Docs\u001B[2K\nPrefix",
              selectionExtras: ["Extra\u001B[2K\nOne", "\u001B[31m\u0007"],
            },
          },
        ],
      }),
    );

    const lines = resolveChannelSelectionNoteLines({
      cfg: {} as never,
      installedPlugins: [],
      selection: ["zalo"],
    });

    expect(formatChannelSelectionLine).toHaveBeenCalledOnce();
    const [selectionMeta, docsLink] = requireFirstMockCall(
      formatChannelSelectionLine.mock.calls,
      "selection line",
    );
    expect(selectionMeta?.label).toBe("Zalo\\nBot");
    expect(selectionMeta?.blurb).toBe("Setup\\nhelp");
    expect(selectionMeta?.docsLabel).toBe("Docs\\nLabel");
    expect(selectionMeta?.selectionDocsPrefix).toBe("Docs\\nPrefix");
    expect(selectionMeta?.selectionExtras).toEqual(["Extra\\nOne"]);
    if (typeof docsLink !== "function") {
      throw new Error("Expected docs link formatter");
    }
    expect(docsLink("/channels/zalo", "Docs")).toBe("https://docs.openclaw.ai/channels/zalo");
    expect(lines).toEqual(["Zalo\\nBot — Setup\\nhelp"]);
  });
});
