import { describe, expect, it } from "vitest";
import {
  parseCommentContentElements,
  resolveCommentLinkedDocumentFromUrl,
} from "./comment-shared.js";

const VALID_TOKEN_22 = "ABCDEFGHIJKLMNOPQRSTUV";
const VALID_TOKEN_27 = "ZsJfdxrBFo0RwuxteOLc1Ekvneb";

describe("resolveCommentLinkedDocumentFromUrl", () => {
  it.each([
    {
      label: "doc",
      url: `https://example.test/doc/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "docs",
      url: `https://example.test/docs/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/doc",
      url: `https://example.test/space/doc/${VALID_TOKEN_22}`,
      expectedKind: "doc",
      expectedResolvedType: "doc",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "sheet",
      url: `https://example.test/sheet/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "sheets",
      url: `https://example.test/sheets/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/sheet",
      url: `https://example.test/space/sheet/${VALID_TOKEN_22}`,
      expectedKind: "sheet",
      expectedResolvedType: "sheet",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "docx with hash",
      url: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}#share-Huggdiqveo5N7NxyA01ck4gLnHh`,
      expectedKind: "docx",
      expectedResolvedType: "docx",
      expectedToken: VALID_TOKEN_27,
    },
    {
      label: "mindnote",
      url: `https://example.test/mindnote/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "mindnotes",
      url: `https://example.test/mindnotes/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/mindnote",
      url: `https://example.test/space/mindnote/${VALID_TOKEN_22}`,
      expectedKind: "mindnote",
      expectedResolvedType: "mindnote",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "bitable",
      url: `https://example.test/bitable/${VALID_TOKEN_22}?table=tbl_123`,
      expectedKind: "bitable",
      expectedResolvedType: "bitable",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "base",
      url: `https://example.test/base/${VALID_TOKEN_22}`,
      expectedKind: "base",
      expectedResolvedType: "base",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/bitable",
      url: `https://example.test/space/bitable/${VALID_TOKEN_22}`,
      expectedKind: "bitable",
      expectedResolvedType: "bitable",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "file",
      url: `https://example.test/file/${VALID_TOKEN_22}`,
      expectedKind: "file",
      expectedResolvedType: "file",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/file",
      url: `https://example.test/space/file/${VALID_TOKEN_22}`,
      expectedKind: "file",
      expectedResolvedType: "file",
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "wiki",
      url: `https://example.test/wiki/${VALID_TOKEN_22}`,
      expectedKind: "wiki",
      expectedResolvedType: undefined,
      expectedToken: VALID_TOKEN_22,
    },
    {
      label: "space/wiki",
      url: `https://example.test/space/wiki/${VALID_TOKEN_22}`,
      expectedKind: "wiki",
      expectedResolvedType: undefined,
      expectedToken: VALID_TOKEN_22,
    },
  ])("$label", ({ url, expectedKind, expectedResolvedType, expectedToken }) => {
    const linked = resolveCommentLinkedDocumentFromUrl({ rawUrl: url });

    expect(linked.urlKind).toBe(expectedKind);
    expect(linked.resolvedObjType).toBe(expectedResolvedType);
    expect(linked.resolvedObjToken ?? linked.wikiNodeToken).toBe(expectedToken);
  });

  it("does not resolve doc-like paths with short tokens", () => {
    expect(
      resolveCommentLinkedDocumentFromUrl({
        rawUrl: "https://www.baidu.com/docx/guide",
      }),
    ).toEqual({
      rawUrl: "https://www.baidu.com/docx/guide",
      urlKind: "unknown",
    });
  });
});

describe("parseCommentContentElements", () => {
  it("keeps raw external urls in text but excludes unresolved links from structured references", () => {
    const parsed = parseCommentContentElements({
      elements: [
        {
          type: "docs_link",
          docs_link: { url: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}` },
        },
        {
          type: "text_run",
          text_run: { text: " 和 " },
        },
        {
          type: "docs_link",
          docs_link: { url: "https://www.baidu.com/docx/guide" },
        },
      ],
    });

    expect(parsed.plainText).toBe(
      `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27} 和 https://www.baidu.com/docx/guide`,
    );
    expect(parsed.linkedDocuments).toEqual([
      {
        rawUrl: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}`,
        urlKind: "docx",
        resolvedObjType: "docx",
        resolvedObjToken: VALID_TOKEN_27,
        isCurrentDocument: false,
      },
    ]);
  });
});
