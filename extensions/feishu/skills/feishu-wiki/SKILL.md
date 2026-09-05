---
name: feishu-wiki
description: |
  Feishu knowledge-base navigation workflows. Activate when the user mentions a knowledge base, wiki, or wiki link.
---

# Feishu wiki

Use the single `feishu_wiki` tool and its current action schema.

From `https://example.feishu.cn/wiki/ABC123def`, use `ABC123def` as `token`. Treat every `space_id` as an opaque quoted string, even when it contains only digits.

## Navigate

- Use `spaces` to enumerate accessible knowledge spaces and `nodes` for a space or parent node.
- Continue pagination with the returned `page_token` while `has_more` is true, keeping the same space and parent.
- Use `search` when the user provides a query but not an exact node.
- Use `get` to resolve a wiki token to its `node_token`, `obj_token`, and `obj_type`.

## Create and organize

Wiki creation supports only `docx`, `sheet`, and `bitable`; `docx` is the default. Resolve an exact space and parent before create, move, or rename operations, and confirm ambiguous or destructive reorganizations.

## Wiki content workflow

Wiki navigation is independent of the document tool. When `get` returns a `docx` object, use its `obj_token` as `doc_token` with `feishu_doc` to read or edit the page. Other object types require a currently available tool that supports that type; do not treat them as documents.
