# Streaming Markdown Shapes

## Headings and emphasis

This paragraph mixes **bold**, _italic_, `inline code`, and unicode text such as
café, naïve, Größe, 流式渲染, and emoji 🦀🌊 that force surrogate pairs through the
JSON event pipeline.

### Lists

- unordered item one
- unordered item two
  - nested child with `code`
  - nested child with a [link](https://docs.openclaw.ai)
- unordered item three

1. ordered first
2. ordered second
3. ordered third

### Fenced code

```kotlin
fun greet(name: String): String {
  val trimmed = name.trim()
  return "Hello, $trimmed! <tags> & \"quotes\" survive"
}
```

```json
{ "runId": "run-1", "state": "delta", "text": "chunk — escaped" }
```

### Table

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| alpha    | 1        | true     |
| beta     | 2        | false    |
| gamma 🦀 | 3        | null     |

> Blockquote line one
> Blockquote line two

---

### Long paragraph

Streaming transports must not corrupt long unbroken prose, so this single paragraph keeps going for quite a while without any line breaks to make sure chunk boundaries land in the middle of words, punctuation, and multi-byte sequences like ünïcödé and 🦀, verifying that every accumulated snapshot remains a strict prefix of the final text and that the terminal snapshot is byte-identical to this fixture file exactly as it was committed, trailing newline included.
