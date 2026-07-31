// Feishu tests cover content_v2 image inline-replacement behavior.
import { describe, expect, it } from "vitest";
import {
  extractMarkdownImageKeys,
  extractMarkdownMentionIds,
  inlineReplacePostImages,
} from "./post-image-inline.js";

describe("inlineReplacePostImages", () => {
  it("rewrites only the URL when alt text contains the same (key) substring", () => {
    const text = "![see (img_abc) here](img_abc)";
    const out = inlineReplacePostImages(text, new Map([["img_abc", "/tmp/img_abc.png"]]));
    // alt text's literal "(img_abc)" stays; only the trailing URL is rewritten.
    expect(out).toBe("![see (img_abc) here](/tmp/img_abc.png)");
  });

  it("inserts the path literally even when it contains regex-replacement specials ($)", () => {
    const text = "![a](img_x)";
    const out = inlineReplacePostImages(text, new Map([["img_x", "/tmp/$1$&dir/a.png"]]));
    expect(out).toBe("![a](/tmp/$1$&dir/a.png)");
  });

  it("keeps escaped image markers literal while rewriting markers after an escaped backslash", () => {
    const text = String.raw`\![literal](img_escaped) \\![real](img_real)`;
    const out = inlineReplacePostImages(text, new Map([["img_real", "/tmp/real.png"]]));
    expect(out).toBe(String.raw`\![literal](img_escaped) \\![real](/tmp/real.png)`);
  });

  it("preserves escaped and nested brackets in alt text", () => {
    const text = String.raw`![before \] after](img_escaped_alt) ![outer [inner]](img_nested)`;
    const out = inlineReplacePostImages(
      text,
      new Map([
        ["img_escaped_alt", "/tmp/escaped.png"],
        ["img_nested", "/tmp/nested.png"],
      ]),
    );
    expect(out).toBe(
      String.raw`![before \] after](/tmp/escaped.png) ![outer [inner]](/tmp/nested.png)`,
    );
  });

  it("replaces non-code-block image_key refs with local paths (AC-M1-H2)", () => {
    const text = "看图：\n\n![架构图](img_abc123)\n\n```md\n![fake](img_abc123)\n```";
    const out = inlineReplacePostImages(
      text,
      new Map([["img_abc123", "/tmp/feishu/img_abc123.png"]]),
    );
    expect(out).toContain("![架构图](/tmp/feishu/img_abc123.png)");
    // 代码块内同 key 保留字面，不替换。
    expect(out).toContain("![fake](img_abc123)");
  });

  it("keeps original ref when key has no local path (download failed) (AC-M1-R1)", () => {
    const text = "![a](img_ok) ![b](img_fail)";
    const out = inlineReplacePostImages(text, new Map([["img_ok", "/tmp/ok.png"]]));
    expect(out).toBe("![a](/tmp/ok.png) ![b](img_fail)");
  });

  it("is a no-op when text has no image markdown (content fallback placeholder)", () => {
    const text = "本周进展：![image]\n详见文档";
    const out = inlineReplacePostImages(text, new Map());
    expect(out).toBe(text);
  });
});

describe("extractMarkdownImageKeys", () => {
  it("dedupes a key referenced multiple times (one image, one download)", () => {
    expect(extractMarkdownImageKeys("![a](img_1) and again ![b](img_1)")).toStrictEqual(["img_1"]);
  });

  it("skips code-block images but keeps real ones", () => {
    const text = "![real](img_real)\n\n```md\n![fake](img_code)\n```\n\n`![inline](img_inline)`";
    expect(extractMarkdownImageKeys(text)).toStrictEqual(["img_real"]);
  });

  it.each([
    ["tilde fence", "~~~md\n![fake](img_tilde)\n~~~"],
    ["longer backtick fence", "````md\n![fake](img_long)\n`````"],
    ["unterminated fence", "```md\n![fake](img_unterminated)"],
    ["multi-backtick inline code", "`` `![fake](img_inline)` ``"],
  ])("skips image refs inside %s", (_name, code) => {
    expect(extractMarkdownImageKeys(`${code}\n![real](img_real)`)).toStrictEqual(
      code.includes("unterminated") ? [] : ["img_real"],
    );
  });

  it("extracts images between escaped backticks", () => {
    expect(extractMarkdownImageKeys("\\`literal ![diagram](img_key) \\`")).toEqual(["img_key"]);
  });

  it("extracts an image after an escaped run closes code", () => {
    expect(extractMarkdownImageKeys("`code \\` ![diagram](img_key) `")).toEqual(["img_key"]);
  });

  it("skips escaped image markers", () => {
    expect(
      extractMarkdownImageKeys(String.raw`\![literal](img_escaped) ![real](img_real)`),
    ).toEqual(["img_real"]);
  });

  it("extracts keys after escaped and nested alt brackets", () => {
    expect(
      extractMarkdownImageKeys(
        String.raw`![before \] after](img_escaped_alt) ![outer [inner]](img_nested)`,
      ),
    ).toEqual(["img_escaped_alt", "img_nested"]);
  });
});

describe("extractMarkdownMentionIds", () => {
  it("extracts native mentions outside code and skips escaped or incomplete tags", () => {
    const text = [
      '<at user_id="ou_real">OpenClaw</at>',
      '`<at user_id="ou_inline">Inline</at>`',
      '```md\n<at user_id="ou_fenced">Fenced</at>\n```',
      String.raw`\<at user_id="ou_escaped">Escaped</at>`,
      '<at user_id="ou_incomplete">Incomplete',
      '<at user_id="ou_real">OpenClaw again</at>',
    ].join("\n");

    expect(extractMarkdownMentionIds(text)).toStrictEqual(["ou_real"]);
  });
});
