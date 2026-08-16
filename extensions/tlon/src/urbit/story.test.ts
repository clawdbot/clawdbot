import { describe, expect, it } from "vitest";
import { markdownToStory, type Story } from "./story.js";

type ListRenderingFixture = {
  name: string;
  markdown: string;
  before: Story;
  after: Story;
};

const listRenderingFixtures: ListRenderingFixture[] = [
  {
    name: "unordered markers become one native unordered listing",
    markdown: "- alpha\n- **beta**\n- [site](https://example.com)",
    before: [
      {
        inline: [
          "- alpha",
          { break: null },
          "- ",
          { bold: ["beta"] },
          { break: null },
          "- ",
          { link: { href: "https://example.com", content: "site" } },
        ],
      },
    ],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [
                { item: ["alpha"] },
                { item: [{ bold: ["beta"] }] },
                {
                  item: [{ link: { href: "https://example.com", content: "site" } }],
                },
              ],
            },
          },
        },
      },
    ],
  },
  {
    name: "ordered markers become a native ordered listing",
    markdown: "1. first\n2. second",
    before: [{ inline: ["1. first", { break: null }, "2. second"] }],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "ordered",
              contents: [],
              items: [{ item: ["first"] }, { item: ["second"] }],
            },
          },
        },
      },
    ],
  },
  {
    name: "task markers become native task inlines inside a task listing",
    markdown: "- [ ] todo\n- [x] **done**",
    before: [
      {
        inline: ["- [ ] todo", { break: null }, "- [x] ", { bold: ["done"] }],
      },
    ],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "tasklist",
              contents: [],
              items: [
                { item: [{ task: { checked: false, content: ["todo"] } }] },
                {
                  item: [{ task: { checked: true, content: [{ bold: ["done"] }] } }],
                },
              ],
            },
          },
        },
      },
    ],
  },
  {
    name: "nested ordered items stay recursive under their unordered parent",
    markdown: "- parent\n  1. first\n  2. second\n- sibling",
    before: [
      {
        inline: [
          "- parent",
          { break: null },
          "  1. first",
          { break: null },
          "  2. second",
          { break: null },
          "- sibling",
        ],
      },
    ],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [
                {
                  list: {
                    type: "ordered",
                    contents: ["parent"],
                    items: [{ item: ["first"] }, { item: ["second"] }],
                  },
                },
                { item: ["sibling"] },
              ],
            },
          },
        },
      },
    ],
  },
  {
    name: "mixed task and plain children stay in their nested bullet list",
    markdown: "- parent\n  - [ ] todo\n  - note\n- sibling",
    before: [
      {
        inline: [
          "- parent",
          { break: null },
          "  - [ ] todo",
          { break: null },
          "  - note",
          { break: null },
          "- sibling",
        ],
      },
    ],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [
                {
                  list: {
                    type: "unordered",
                    contents: ["parent"],
                    items: [
                      { item: [{ task: { checked: false, content: ["todo"] } }] },
                      { item: ["note"] },
                    ],
                  },
                },
                { item: ["sibling"] },
              ],
            },
          },
        },
      },
    ],
  },
  {
    name: "empty bullet items stay inside their native listing",
    markdown: "- first\n-\n- third",
    before: [{ inline: ["- first", { break: null }, "-", { break: null }, "- third"] }],
    after: [
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [{ item: ["first"] }, { item: [] }, { item: ["third"] }],
            },
          },
        },
      },
    ],
  },
];

describe("markdownToStory list rendering", () => {
  it.each(listRenderingFixtures)("$name", ({ markdown, before, after }) => {
    expect(before).not.toEqual(after);
    expect(markdownToStory(markdown)).toEqual(after);
  });

  it("preserves a list with lazy continuation after preceding paragraph text", () => {
    expect(markdownToStory("intro\n- one\n- two\noutro")).toEqual([
      {
        inline: [
          "intro",
          { break: null },
          "- one",
          { break: null },
          "- two",
          { break: null },
          "outro",
        ],
      },
    ]);
  });

  it("keeps a blank-separated outer sibling attached after a nested list", () => {
    expect(markdownToStory("- parent\n  - child\n\n- sibling")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [
                {
                  list: {
                    type: "unordered",
                    contents: ["parent"],
                    items: [{ item: ["child"] }],
                  },
                },
                { item: ["sibling"] },
              ],
            },
          },
        },
      },
    ]);
  });

  it.each([
    {
      name: "non-1 ordered starts",
      markdown: "5. five\n6. six",
      expected: [{ inline: ["5. five", { break: null }, "6. six"] }],
    },
    {
      name: "consecutive nested list styles",
      markdown: "- parent\n  - bullet child\n  1. numbered child",
      expected: [
        {
          inline: [
            "- parent",
            { break: null },
            "  - bullet child",
            { break: null },
            "  1. numbered child",
          ],
        },
      ],
    },
    {
      name: "four-space-indented list-like text",
      markdown: "    - literal",
      expected: [{ inline: ["    - literal"] }],
    },
    {
      name: "under-indented children of wide ordered markers",
      markdown: "1. parent\n  - child",
      expected: [{ inline: ["1. parent", { break: null }, "  - child"] }],
    },
    {
      name: "block-level content inside list items",
      markdown: "- foo\n\n      bar",
      expected: [{ inline: ["- foo"] }, { inline: ["      bar"] }],
    },
    {
      name: "block syntax on the marker line",
      markdown: "- # heading",
      expected: [{ inline: ["- # heading"] }],
    },
    {
      name: "blank-separated item paragraphs",
      markdown: "- first\n\n  second",
      expected: [{ inline: ["- first"] }, { inline: ["  second"] }],
    },
    {
      name: "indented code beginning with a marker",
      markdown: "- foo\n\n      - literal",
      expected: [{ inline: ["- foo"] }, { inline: ["      - literal"] }],
    },
    {
      name: "parent content after a nested list",
      markdown: "- parent\n  - child\n\n  tail",
      expected: [{ inline: ["- parent", { break: null }, "  - child"] }, { inline: ["  tail"] }],
    },
    {
      name: "images inside list items",
      markdown: "- ![diagram](https://example.com/diagram.png)",
      expected: [
        {
          inline: [
            "- !",
            { link: { href: "https://example.com/diagram.png", content: "diagram" } },
          ],
        },
      ],
    },
    {
      name: "indented continuation lines",
      markdown: "- first line\n  continued\n- second",
      expected: [
        {
          inline: ["- first line", { break: null }, "  continued", { break: null }, "- second"],
        },
      ],
    },
    {
      name: "tab-indented underflow beneath a padded marker",
      markdown: "-    parent\n \t- child",
      expected: [{ inline: ["-    parent", { break: null }, " \t- child"] }],
    },
    {
      name: "ordered markers longer than nine digits",
      markdown: "0000000001. value",
      expected: [{ inline: ["0000000001. value"] }],
    },
    {
      name: "same-line nested list syntax",
      markdown: "- - child",
      expected: [{ inline: ["- - child"] }],
    },
    {
      name: "blockquote marker without whitespace",
      markdown: "- >quoted",
      expected: [{ inline: ["- >quoted"] }],
    },
  ])("preserves $name as plain story content", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("keeps different ordered delimiters as separate native lists", () => {
    expect(markdownToStory("1. first\n1) reset")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "ordered",
              contents: [],
              items: [{ item: ["first"] }],
            },
          },
        },
      },
      {
        block: {
          listing: {
            list: {
              type: "ordered",
              contents: [],
              items: [{ item: ["reset"] }],
            },
          },
        },
      },
    ]);
  });

  it("keeps ordered task items in an ordered native listing", () => {
    expect(markdownToStory("1. [ ] first\n2. [x] second")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "ordered",
              contents: [],
              items: [
                { item: [{ task: { checked: false, content: ["first"] } }] },
                { item: [{ task: { checked: true, content: ["second"] } }] },
              ],
            },
          },
        },
      },
    ]);
  });

  it("keeps variably indented ordered siblings in one native list", () => {
    expect(markdownToStory(" 1. first\n2. second")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "ordered",
              contents: [],
              items: [{ item: ["first"] }, { item: ["second"] }],
            },
          },
        },
      },
    ]);
  });

  it("preserves a non-interrupting ordered marker as lazy text", () => {
    expect(markdownToStory("- first\n2. continuation")).toEqual([
      { inline: ["- first", { break: null }, "2. continuation"] },
    ]);
  });

  it.each(["- [ ] - follow up", "- [x] # heading"])(
    "keeps block-looking task text representable for %s",
    (markdown) => {
      const checked = markdown.includes("[x]");
      const content = markdown.replace(/^- \[[ x]\] /, "");
      expect(markdownToStory(markdown)).toEqual([
        {
          block: {
            listing: {
              list: {
                type: "tasklist",
                contents: [],
                items: [{ item: [{ task: { checked, content: [content] } }] }],
              },
            },
          },
        },
      ]);
    },
  );

  it("keeps whitespace-only items in their native list", () => {
    expect(markdownToStory("- first\n-     \n- third")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "unordered",
              contents: [],
              items: [{ item: ["first"] }, { item: [] }, { item: ["third"] }],
            },
          },
        },
      },
    ]);
  });

  it("preserves an empty same-marker nested item as paragraph text", () => {
    expect(markdownToStory("- parent\n  -")).toEqual([
      { inline: ["- parent", { break: null }, "  -"] },
    ]);
  });

  it("accepts a tab as an unchecked task marker", () => {
    expect(markdownToStory("- [\t] todo")).toEqual([
      {
        block: {
          listing: {
            list: {
              type: "tasklist",
              contents: [],
              items: [{ item: [{ task: { checked: false, content: ["todo"] } }] }],
            },
          },
        },
      },
    ]);
  });

  it("preserves blank-separated siblings after an unsupported list item", () => {
    expect(markdownToStory("- # heading\n\n- sibling")).toEqual([
      { inline: ["- # heading"] },
      { inline: ["- sibling"] },
    ]);
  });

  it("keeps ordinary inline Markdown outside loose-list preservation", () => {
    expect(markdownToStory("**bold**")).toEqual([{ inline: [{ bold: ["bold"] }] }]);
  });

  it("keeps the unsupported outer marker across nested marker styles", () => {
    expect(markdownToStory("- # heading\n  * child\n\n- sibling")).toEqual([
      { inline: ["- # heading", { break: null }, "  * child"] },
      { inline: ["- sibling"] },
    ]);
  });

  it("does not let an empty list item interrupt a paragraph", () => {
    expect(markdownToStory("foo\n*")).toEqual([{ inline: ["foo", { break: null }, "*"] }]);
  });

  it.each(["- ~~~", "- >", "- ___", "-     code"])(
    "preserves block-level marker body %s as plain content",
    (markdown) => {
      expect(markdownToStory(markdown)).toEqual([{ inline: [markdown] }]);
    },
  );

  it.each([
    { markdown: "- - -", expected: [{ inline: ["- - -"] }] },
    { markdown: "* * *", expected: [{ inline: [{ italics: [" "] }, " *"] }] },
  ])("does not convert thematic break $markdown into a listing", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("preserves lazy continuation text with its list markers", () => {
    expect(markdownToStory("- first\ncontinued\n- second")).toEqual([
      { inline: ["- first", { break: null }, "continued", { break: null }, "- second"] },
    ]);
  });
});
