import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toStreamingMarkdownParts code fences", () => {
  it.each([
    { name: "an unfinished fence", markdown: "```mermaid\nflowchart LR\nA --> B", diagrams: 0 },
    {
      name: "a finished response",
      markdown: "```mermaid\nflowchart LR\nA --> B",
      final: true,
      diagrams: 1,
    },
    { name: "a closed fence", markdown: "```mermaid\nflowchart LR\nA --> B\n```", diagrams: 1 },
    { name: "a tilde fence", markdown: "~~~Mermaid\nflowchart LR\nA --> B\n~~~", diagrams: 1 },
    { name: "a shell fence", markdown: "```bash\nflowchart LR\nA --> B\n```", diagrams: 0 },
    {
      name: "an authored HTML marker",
      markdown: '<div class="markdown-mermaid"><pre><code>flowchart LR</code></pre></div>',
      diagrams: 0,
    },
    {
      name: "closed then open fences",
      markdown: "```mermaid\nflowchart LR\nA --> B\n```\n\n```mermaid\nflowchart LR\nC --> D",
      diagrams: 1,
    },
  ])("only mounts complete Mermaid source: $name", ({ markdown, diagrams, final }) => {
    const fragment = htmlFragment(
      final ? toSanitizedMarkdownHtml(markdown) : toStreamingMarkdownParts(markdown).join(""),
    );
    expect(fragment.querySelectorAll(".markdown-mermaid")).toHaveLength(diagrams);
    for (const diagram of fragment.querySelectorAll(".markdown-mermaid")) {
      expect(diagram.querySelector("pre code")?.textContent).toContain("flowchart LR");
    }
  });

  it("streams an open code fence without syntax highlighting", () => {
    const html = toStreamingMarkdownParts("Intro\n\n```ts\nconst x = 1 < 2").join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("code.language-ts");

    expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    expect(code?.textContent).toContain("const x = 1 < 2");
    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.querySelector("span")).toBeNull();
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("highlights only completed fences inside an open details block", () => {
    const html = toStreamingMarkdownParts(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst closed = 1;\n```\n\n```ts\nconst open = 2;",
    ).join("");
    const code = htmlFragment(html).querySelectorAll("details code.language-ts");

    expect(code).toHaveLength(2);
    expect(code[0]?.classList.contains("hljs")).toBe(true);
    expect(code[0]?.querySelector("span")).not.toBeNull();
    expect(code[1]?.classList.contains("hljs")).toBe(false);
    expect(code[1]?.querySelector("span")).toBeNull();
  });

  it("keeps a completed fence highlighted when a later backtick fence has invalid info", () => {
    const html = toStreamingMarkdownParts(
      "- ```ts\n  const closed = 1;\n  ```\n\n  ```bad`info\n  trailing text",
    ).join("");
    const code = htmlFragment(html).querySelector("code.language-ts");

    expect(code?.textContent).toContain("const closed = 1;");
    expect(code?.classList.contains("hljs")).toBe(true);
  });

  it("streams an open list code fence through blank lines", () => {
    const html = toStreamingMarkdownParts("- ```ts\n  const x = 1;\n\n  const y = 2;").join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("li code");

    expect(code?.textContent).toContain("const x = 1;");
    expect(code?.textContent).toContain("const y = 2;");
    expect(code?.classList.contains("hljs")).toBe(false);
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("keeps completed tilde-fence code out of the remend tail", () => {
    // remend only understands ``` fences; a closed ~~~ block must land in the
    // stable prefix so its raw markers are never "completed" as inline markdown.
    const html = toStreamingMarkdownParts(
      '~~~ts\nconst s = "**open";\n~~~\ncontinuing **bold',
    ).join("");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("code")?.textContent).toContain('const s = "**open";');
    expect(fragment.querySelector("code strong")).toBeNull();
    expect(fragment.querySelector("p strong")?.textContent).toBe("bold");
  });

  it("streams an open blockquote code fence through blank lines", () => {
    const html = toStreamingMarkdownParts("> ```ts\n> const x = 1;\n>\n> const y = 2;").join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("blockquote code");

    expect(code?.textContent).toContain("const x = 1;");
    expect(code?.textContent).toContain("const y = 2;");
    expect(code?.classList.contains("hljs")).toBe(false);
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("renders a completed code fence once the closing fence arrives", () => {
    const markdown = "```ts\nconst x = 1;\n```";
    const html = toStreamingMarkdownParts(markdown).join("");

    expect(html).toContain('<code class="hljs language-ts"');
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("markdown-plain-text-fallback");
    expect(html).toBe(toSanitizedMarkdownHtml(markdown));
  });
});
