from pathlib import Path
from ranchbrain.models import Memory

def render_memory_markdown(memory: Memory, json_path: Path) -> Path:
    md_path = json_path.with_suffix(".md")

    tags = "\n".join([f"  - {tag}" for tag in memory.tags]) or "  - none"

    if memory.references:
        refs = "\n".join(
            [
                f"- {ref.title or ref.type}: {ref.value} "
                f"(type: {ref.type}, confidence: {ref.confidence})"
                for ref in memory.references
            ]
        )
    else:
        refs = "_None_"

    content = f"""---
id: {memory.id}
module: {memory.module}
category: {memory.category}
type: {memory.memory_type}
created_at: {memory.created_at}
updated_at: {memory.updated_at}
privacy_level: {memory.privacy_level}
tags:
{tags}
---

# {memory.title}

**Memory ID:** {memory.id}

**Module:** {memory.module}

**Category:** {memory.category}

**Type:** {memory.memory_type}

**Confidence:** {memory.confidence}

---

## Summary

{memory.body}

---

## References

{refs}

---

Generated automatically by RanchBrain.
"""

    md_path.write_text(content)
    return md_path
