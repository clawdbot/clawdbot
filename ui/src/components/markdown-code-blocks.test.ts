import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { markdownBlocks } from "./markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.body.innerHTML = "";
});

function renderCodeCopyButton(text = "const answer = 42;"): HTMLButtonElement {
  document.body.innerHTML = toSanitizedMarkdownHtml(`\`\`\`ts\n${text}\n\`\`\``);
  const button = document.querySelector<HTMLButtonElement>(".code-block-copy");
  if (!button) {
    throw new Error("Expected Markdown code-copy button");
  }
  button.addEventListener("click", handleMarkdownCodeBlockClick);
  return button;
}

it("reobserves reused Markdown DOM while fencing scans queued before disconnect", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const container = document.body.appendChild(document.createElement("div"));
  const content = toSanitizedMarkdownHtml(
    "```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | One |",
    {
      codeBlockInteraction: "interactive",
      tableInteractions: "enabled",
    },
  );
  const view = (active = true) =>
    html`<section class="chat-text" ${markdownBlocks(active)}>${unsafeHTML(content)}</section>`;
  const part = render(view(), container);
  const code = container.querySelector("code");
  const tableViewport = container.querySelector(".markdown-table__viewport");

  try {
    part.setConnected(false);
    await Promise.resolve();
    expect(observed.size).toBe(0);

    part.setConnected(true);
    await Promise.resolve();
    expect(observed.size).toBe(3);
    expect(observed.has(code!)).toBe(true);
    expect(observed.has(tableViewport!)).toBe(true);

    part.setConnected(false);
    expect(observed.size).toBe(0);
    part.setConnected(true);
    await Promise.resolve();
    expect(container.querySelector("code")).toBe(code);
    expect(observed.has(code!)).toBe(true);
    expect(container.querySelector(".markdown-table__viewport")).toBe(tableViewport);
    expect(observed.has(tableViewport!)).toBe(true);
    expect(observed.size).toBe(3);

    render(view(false), container);
    await Promise.resolve();
    expect(observed.size).toBe(0);
    expect(container.querySelector("code")).toBe(code);
    render(view(true), container);
    render(view(false), container);
    await Promise.resolve();
    expect(observed.size).toBe(0);
    render(view(true), container);
    await Promise.resolve();
    expect(observed.size).toBe(3);
    expect(observed.has(code!)).toBe(true);
    expect(observed.has(tableViewport!)).toBe(true);
  } finally {
    render(nothing, container);
  }
});

describe("Markdown code-block clipboard feedback", () => {
  it.each([
    { name: "indentation and a final newline", source: "  const answer = 42;\n" },
    { name: "boundary blank lines", source: "\n\nconst answer = 42;\n\n" },
    { name: "whitespace-only content", source: " \n\t " },
    { name: "HTML comments", source: "<!-- ordinary comment -->" },
    { name: "comment-like arrows", source: "A --> B --!> C" },
    { name: "CDATA terminators", source: "]]>" },
    {
      name: "closing HTML tags",
      source: '<script>console.log("ok")</script>\n</style></textarea>',
    },
    { name: "literal Unicode escapes", source: String.raw`\u003c!-- 🦞 -->\u003e` },
  ])("preserves $name when copying ordinary code", async ({ source }) => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const button = renderCodeCopyButton(source);

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith(source);
  });

  it("visibly reports both denied clipboard paths and restores the idle state", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {
      throw new DOMException("Clipboard access denied", "NotAllowedError");
    });
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.classList.contains("copied")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(button.classList.contains("copy-failed")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("preserves successful copy feedback and restores its accessible label", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copied!");

    await vi.advanceTimersByTimeAsync(1_500);

    expect(button.classList.contains("copied")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("ignores an older clipboard attempt that finishes after the latest denied copy", async () => {
    vi.useFakeTimers();
    let resolveFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const writeText = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    resolveFirstWrite();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.classList.contains("copied")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it.each([
    { name: "a previous denied copy", firstSucceeds: false, firstResetAtMs: 2_000 },
    { name: "a previous successful copy", firstSucceeds: true, firstResetAtMs: 1_500 },
  ])("keeps the latest denied-copy feedback after $name", async (scenario) => {
    vi.useFakeTimers();
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"));
    if (scenario.firstSucceeds) {
      writeText.mockResolvedValueOnce(undefined);
    }
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(1_000);
    button.click();
    await vi.advanceTimersByTimeAsync(scenario.firstResetAtMs - 1_000);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    await vi.advanceTimersByTimeAsync(3_000 - scenario.firstResetAtMs);

    expect(button.classList.contains("copy-failed")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("keeps independent reset deadlines for different code-copy buttons", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const first = renderCodeCopyButton();
    const second = first.cloneNode(true) as HTMLButtonElement;
    second.addEventListener("click", handleMarkdownCodeBlockClick);
    document.body.append(second);

    first.click();
    await vi.advanceTimersByTimeAsync(500);
    second.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(first.getAttribute("aria-label")).toBe("Copy code");
    expect(second.getAttribute("aria-label")).toBe("Copy failed");

    second.remove();
    await vi.advanceTimersByTimeAsync(500);

    expect(second.getAttribute("aria-label")).toBe("Copy code");
  });
});

describe("toSanitizedMarkdownHtml code blocks", () => {
  const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
  const jsonBlock = (lineCount: number) => {
    const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
    values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
    return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
  };

  async function expectCodeCopy(fragment: HTMLElement, text: string) {
    const writeText = vi.fn(async () => undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      document.body.append(fragment);
      const button = fragment.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(button).toBeInstanceOf(HTMLButtonElement);
      button!.click();
      await vi.waitFor(() => expect(button!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledWith(text);
    } finally {
      fragment.remove();
      fragment.removeEventListener("click", handleMarkdownCodeBlockClick);
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  }

  it("renders raw block art as a whitespace-preserving code block", () => {
    const rendered = toSanitizedMarkdownHtml(blockArt);
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("recognizes block art separated by Unicode line boundaries", () => {
    const rendered = toSanitizedMarkdownHtml("  ▀▀▀▀  \u2028  ▄▄▄▄  \u2029  ████  ");
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe("  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ");
  });

  it("marks fenced block art without syntax highlighting", () => {
    const rendered = toSanitizedMarkdownHtml(`\`\`\`\n${blockArt}\n\`\`\``);
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.textContent).toBe(`${blockArt}\n`);
  });

  it("copies fenced block art with its quiet-zone whitespace intact", async () => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(`\`\`\`\n${blockArt}\n\`\`\``));
    await expectCodeCopy(fragment, blockArt);
  });

  it("renders indented code blocks", async () => {
    // markdown-it requires a blank line before indented code
    const rendered = toSanitizedMarkdownHtml("text\n\n    indented code");
    const fragment = htmlFragment(rendered);

    expect(fragment.querySelector("p")?.textContent).toBe("text");
    expect(fragment.querySelector(".code-block-lang")?.textContent).toBe("Code");
    expect(fragment.querySelector("pre code")?.textContent).toBe("indented code\n");
    await expectCodeCopy(fragment, "indented code");
  });

  it("includes copy button", async () => {
    const rendered = toSanitizedMarkdownHtml("```\ncode\n```");
    const fragment = htmlFragment(rendered);

    expect(fragment.querySelector(".code-block-lang")?.textContent).toBe("Code");
    expect(fragment.querySelector(".code-block-copy__idle")).toBeInstanceOf(HTMLSpanElement);
    await expectCodeCopy(fragment, "code");
  });

  it("omits copy chrome when rendering user-preserved code blocks", () => {
    const source = `python3 - <<'PY'
import openpyxl

for ws in wb.worksheets:
  print(f"--- {ws.title} ---")
  rows = 0

  for row in ws.iter_rows(values_only=True):
      print(row)
PY
`;
    const rendered = toSanitizedMarkdownHtml(`\`\`\`bash\n${source}\`\`\``, {
      codeBlockChrome: "none",
    });
    const fragment = htmlFragment(rendered);

    expect(fragment.querySelector(".code-block-copy")).toBeNull();
    expect(fragment.querySelector(".code-block-wrapper")).toBeNull();
    expect(fragment.querySelector("pre code")?.textContent).toBe(source);
  });

  it("keeps short code blocks fully visible in interactive hosts", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(7), { codeBlockInteraction: "interactive" }),
    );
    const code = fragment.querySelector(".code-block-viewport pre code");

    expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeNull();
    expect(fragment.querySelector(".code-block-expand")).toBeNull();
    expect(code?.textContent?.split("\n")).toHaveLength(8);
    expect(code?.innerHTML).toContain("hljs-");
  });

  it("previews longer code blocks with the exact hidden-line count", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(11), { codeBlockInteraction: "interactive" }),
    );
    const expand = fragment.querySelector(".code-block-expand");

    expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(expand?.textContent).toContain("4 hidden lines");
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(fragment.querySelector(".code-block-viewport pre code")?.innerHTML).toContain("hljs-");
  });

  it("uses the singular hidden-line label for a single hidden line", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(8), { codeBlockInteraction: "interactive" }),
    );
    const expand = fragment.querySelector(".code-block-expand");

    expect(expand?.textContent).toBe("1 hidden line");
    expect(expand?.getAttribute("aria-label")).toBe("Show 1 hidden line");
  });

  it.each(["text", "md", "markdown", "TEXT", "Markdown title=notes"])(
    "keeps long %s fences fully visible",
    (info) => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(`\`\`\`${info}\n${"prose line\n".repeat(20)}\`\`\``, {
          codeBlockInteraction: "interactive",
        }),
      );

      expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeNull();
      expect(fragment.querySelector(".code-block-expand")).toBeNull();
      expect(fragment.querySelector("pre code")?.textContent).toContain("prose line");
    },
  );

  it.each([
    { info: "json", content: '"value",\n'.repeat(20) },
    { info: "bash", content: "echo hi\n".repeat(20) },
    { info: "", content: "unlabeled line\n".repeat(20) },
  ])("keeps long $info fences collapsible", ({ info, content }) => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(`\`\`\`${info}\n${content}\`\`\``, {
        codeBlockInteraction: "interactive",
      }),
    );

    expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(fragment.querySelector(".code-block-expand")?.textContent).toContain("13 hidden lines");
  });

  it("keeps collapse and wrap controls out of hosts that do not own them", () => {
    const markdown = jsonBlock(41);
    const staticHost = htmlFragment(toSanitizedMarkdownHtml(markdown));
    const interactiveHost = htmlFragment(
      toSanitizedMarkdownHtml(markdown, { codeBlockInteraction: "interactive" }),
    );

    expect(staticHost.querySelector(".code-block-expand")).toBeNull();
    expect(staticHost.querySelector(".code-block-wrap")).toBeNull();
    expect(staticHost.querySelector(".code-block-viewport")).toBeNull();
    expect(staticHost.querySelector(".code-block-copy")).toBeInstanceOf(HTMLButtonElement);
    expect(interactiveHost.querySelector(".code-block-expand")).toBeInstanceOf(HTMLButtonElement);
    expect(interactiveHost.querySelector(".code-block-wrap")).toBeInstanceOf(HTMLButtonElement);
  });

  it("reveals a collapsed block through the shared click owner", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
    );
    const wrapper = fragment.querySelector(".code-block-wrapper");
    const expand = fragment.querySelector<HTMLButtonElement>(".code-block-expand");
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);

    expand?.click();

    expect(wrapper?.classList.contains("is-expanded")).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles wrapping through the shared click owner", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
    );
    const wrapper = fragment.querySelector(".code-block-wrapper");
    const wrap = fragment.querySelector<HTMLButtonElement>(".code-block-wrap");
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);

    wrap?.click();
    expect(wrapper?.classList.contains("is-wrapped")).toBe(true);
    expect(wrap?.getAttribute("aria-pressed")).toBe("true");

    wrap?.click();
    expect(wrapper?.classList.contains("is-wrapped")).toBe(false);
    expect(wrap?.getAttribute("aria-pressed")).toBe("false");
  });

  it("localizes the hidden-line count and the language fallback", async () => {
    i18n.registerTranslation("pt-BR", {
      chat: {
        codeBlock: {
          languageFallback: "Código",
          hiddenLines: "{count} linhas ocultas",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    try {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
      );
      expect(fragment.querySelector(".code-block-expand")?.textContent).toContain(
        "34 linhas ocultas",
      );
      const unlabeled = htmlFragment(toSanitizedMarkdownHtml("```\nconteúdo\n```"));
      expect(unlabeled.querySelector(".code-block-lang")?.textContent).toBe("Código");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("auto-highlights unlabeled code blocks only when detection is confident", () => {
    const rendered = toSanitizedMarkdownHtml("```\n#include <vector>\nstd::vector<int> nums;\n```");
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code");

    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.textContent).toBe("#include <vector>\nstd::vector<int> nums;\n");
    expect(code?.innerHTML).toContain("hljs-meta");
    expect(code?.innerHTML).toContain("hljs-keyword");
  });

  it("keeps highlighted HTML code escaped", () => {
    const rendered = toSanitizedMarkdownHtml("```html\n<script>alert(1)</script>\n```");
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code");

    expect(code?.querySelector("script")).toBeNull();
    expect(code?.textContent).toBe("<script>alert(1)</script>\n");
    expect(code?.innerHTML).not.toContain("<script>");
  });
});
