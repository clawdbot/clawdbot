// Control UI tests cover the settings row anatomy: art tile, copy and controls
// share one flex line, and only a row-local message breaks onto its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeRowAnatomy = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

// A real registry description: the ClawHub apple-pim-cli summary is long enough
// that its max-content width exceeds any row, which is what used to break the
// line. Shortening it here would stop reproducing the regression.
const LONG_DESCRIPTION =
  "macOS-only. Wraps four native Swift CLIs (calendar-cli, reminder-cli, contacts-cli, mail-cli) you build locally from source via ./setup.sh — no binaries are downloaded by the registry. Grants the agent read/write access to Calendar, Reminders, Contacts, and Mail.app (including send/delete) once you approve the corresponding macOS TCC and Automation prompts.";

// A configured MCP endpoint is identity, not a summary, and the row offers no
// detail surface for it: whatever the operator configured has to stay readable
// in the row however long it is.
const LONG_MCP_TARGET =
  "https://mcp.example.com/tenants/acme-production-eu-west/workspaces/platform-observability/servers/streamable-http/v1/endpoint?region=eu-west-1&profile=read-only-analytics&session=persistent&trace=enabled&compat=2026-08&channel=stable&retry=exponential&fallback=queue";

// Row shapes copied from their renderers: renderPluginRow (plugins/view.ts) and
// renderConfiguredRow (channels/view.ts). Both lead with an art tile, so both
// depend on the copy column never being the item that starts a new flex line.
const FIXTURE_MARKUP = `
<div class="settings-page">
  <section class="settings-section">
    <div class="settings-group">
      <article class="settings-row plugins-item plugins-item--clickable" data-row="plugin">
        <span class="plugins-tile plugins-tile--fallback" aria-hidden="true">AP</span>
        <div class="settings-row__text">
          <h3 class="settings-row__title">
            <button type="button" class="plugins-item__detail-button">
              Apple PIM: Calendar, Reminders, Contacts, Mail
              <span class="plugins-version">v3.16.1</span>
            </button>
          </h3>
          <span class="settings-row__desc plugins-item__summary" data-probe="desc"
            >${LONG_DESCRIPTION}</span
          >
          <span class="settings-row__desc plugins-meta" data-probe="meta"
            >Global<span aria-hidden="true"> · </span
            ><span class="plugins-meta__mono">apple-pim-cli</span></span
          >
        </div>
        <div class="settings-row__control">
          <button type="button" class="btn btn--sm">Disable</button>
          <button type="button" class="btn btn--sm btn--icon">Remove</button>
        </div>
      </article>
      <article class="settings-row plugins-item" data-row="plugin-message">
        <span class="plugins-tile plugins-tile--fallback" aria-hidden="true">BC</span>
        <div class="settings-row__text">
          <h3 class="settings-row__title">Broken Channel</h3>
          <span class="settings-row__desc" data-probe="desc">${LONG_DESCRIPTION}</span>
        </div>
        <div class="settings-row__control">
          <button type="button" class="btn btn--sm">Disable</button>
        </div>
        <div class="plugins-row-message plugins-row-message--error" role="alert" data-probe="message">
          Failed to load plugin manifest.
        </div>
      </article>
      <article class="settings-row plugins-item" data-row="mcp">
        <span class="plugins-tile plugins-tile--fallback" aria-hidden="true">HO</span>
        <div class="settings-row__text">
          <h3 class="settings-row__title">hosted-analytics</h3>
          <span class="settings-row__desc plugins-meta__mono" data-probe="desc"
            >${LONG_MCP_TARGET}</span
          >
          <span class="settings-row__desc plugins-meta" data-probe="meta"
            >MCP<span aria-hidden="true"> · </span>streamable-http</span
          >
        </div>
        <div class="settings-row__control">
          <button type="button" class="btn btn--sm">Disable</button>
        </div>
      </article>
      <button type="button" class="settings-row settings-row--nav channels-item" data-row="channel">
        <span class="channels-tile channels-tile--fallback" aria-hidden="true">TG</span>
        <div class="settings-row__text">
          <span class="settings-row__title">Telegram</span>
          <span class="settings-row__desc" data-probe="desc">${LONG_DESCRIPTION}</span>
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron">&gt;</span>
        </div>
      </button>
    </div>
  </section>
</div>`;

type RowProbe = {
  readonly row: string;
  readonly copyFollowsTile: boolean;
  readonly controlFollowsCopy: boolean;
  readonly controlBelowCopy: boolean;
  readonly tileOffsetFromTitle: number;
  readonly descriptionLines: number;
  readonly descriptionTruncated: boolean;
  readonly metaLines: number | null;
  readonly messageBelowControl: boolean | null;
  readonly messageSpansRow: boolean | null;
};

function fixtureDocument(): string {
  const css = [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/styles/plugins.css",
    "ui/src/styles/channels.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
  return `<!doctype html><html data-theme-mode="dark"><head><meta charset="utf-8"><style>${css}</style></head><body>${FIXTURE_MARKUP}</body></html>`;
}

async function probeRows(width: number): Promise<RowProbe[]> {
  const page = await browser.newPage({ viewport: { height: 1200, width } });
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate(() =>
      [...document.querySelectorAll("[data-row]")].map((row) => {
        const tile = row.querySelector(".plugins-tile, .channels-tile")!.getBoundingClientRect();
        const title = row.querySelector(".settings-row__title")!.getBoundingClientRect();
        const copy = row.querySelector(".settings-row__text")!.getBoundingClientRect();
        const control = row.querySelector(".settings-row__control")!.getBoundingClientRect();
        const description = row.querySelector<HTMLElement>('[data-probe="desc"]')!;
        const meta = row.querySelector<HTMLElement>('[data-probe="meta"]');
        const message = row.querySelector<HTMLElement>('[data-probe="message"]');
        const lines = (element: HTMLElement) =>
          Math.round(
            element.getBoundingClientRect().height /
              Number.parseFloat(getComputedStyle(element).lineHeight),
          );
        return {
          row: row.getAttribute("data-row")!,
          copyFollowsTile: copy.left >= tile.right,
          controlFollowsCopy: control.left >= copy.right,
          controlBelowCopy: control.top >= copy.bottom,
          tileOffsetFromTitle: Math.round(tile.top - title.top),
          descriptionLines: lines(description),
          descriptionTruncated: description.scrollHeight > description.clientHeight,
          metaLines: meta ? lines(meta) : null,
          messageBelowControl: message
            ? message.getBoundingClientRect().top >= control.bottom
            : null,
          messageSpansRow: message
            ? Math.round(message.getBoundingClientRect().width) >=
              Math.round(row.getBoundingClientRect().width) - 40
            : null,
        };
      }),
    );
  } finally {
    await page.close().catch(() => {});
  }
}

let fixtureDirectory: string;
let fixtureFile: string;
let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "settings-row-anatomy-"));
  fixtureFile = path.join(fixtureDirectory, "rows.html");
  fs.writeFileSync(fixtureFile, fixtureDocument(), "utf8");
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describeRowAnatomy("Control UI settings row anatomy", () => {
  it("keeps tile, copy and controls on one line when a description runs long", async () => {
    const rows = await probeRows(1440);

    expect(
      rows.map(({ row, copyFollowsTile, controlFollowsCopy }) => ({
        row,
        copyFollowsTile,
        controlFollowsCopy,
      })),
    ).toEqual([
      { row: "plugin", copyFollowsTile: true, controlFollowsCopy: true },
      { row: "plugin-message", copyFollowsTile: true, controlFollowsCopy: true },
      { row: "mcp", copyFollowsTile: true, controlFollowsCopy: true },
      { row: "channel", copyFollowsTile: true, controlFollowsCopy: true },
    ]);
  });

  it("keeps the tile beside the copy at the stacked breakpoint", async () => {
    const rows = await probeRows(393);

    // <=640px stacks the control under the copy on purpose; the tile stays put.
    expect(
      rows.map(({ row, copyFollowsTile, controlBelowCopy }) => ({
        row,
        copyFollowsTile,
        controlBelowCopy,
      })),
    ).toEqual([
      { row: "plugin", copyFollowsTile: true, controlBelowCopy: true },
      { row: "plugin-message", copyFollowsTile: true, controlBelowCopy: true },
      { row: "mcp", copyFollowsTile: true, controlBelowCopy: true },
      { row: "channel", copyFollowsTile: true, controlBelowCopy: true },
    ]);
  });

  it("gives a row-local message its own full-width line below the controls", async () => {
    const rows = await probeRows(1440);
    const messageRow = rows.find((row) => row.row === "plugin-message");

    expect(messageRow).toMatchObject({ messageBelowControl: true, messageSpansRow: true });
  });

  it("clamps a plugin description to two lines and keeps the meta line single", async () => {
    const rows = await probeRows(1440);

    expect(rows.find((row) => row.row === "plugin")).toMatchObject({
      descriptionLines: 2,
      descriptionTruncated: true,
      metaLines: 1,
    });
  });

  it.each([1440, 393])("never clips a configured MCP target at %ipx", async (width) => {
    const target = (await probeRows(width)).find((row) => row.row === "mcp");

    expect(target).toMatchObject({ descriptionTruncated: false, metaLines: 1 });
    // Long enough that the clamp would have hidden it; the assertion above is
    // only meaningful while this row still overflows two lines.
    expect(target?.descriptionLines).toBeGreaterThan(2);
  });

  it("anchors the plugin tile to the row title instead of the copy block", async () => {
    const rows = await probeRows(1440);

    expect(rows.find((row) => row.row === "plugin")?.tileOffsetFromTitle).toBeLessThanOrEqual(2);
  });
});
