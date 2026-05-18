---
name: skill-creator
description: "Create, edit, audit, tidy, validate, or restructure AgentSkills and SKILL.md files."
---

# Skill Creator

Skills are compact triggerable workflows. Metadata is always visible; body loads only after trigger; references/scripts/assets load only as needed.

## Hard rules

- Keep `SKILL.md` lean; Codex is already capable.
- Put only trigger-critical facts in frontmatter `description`.
- Quote frontmatter `description`.
- Frontmatter needs `name` + `description`; local OpenClaw skills may also use `metadata`, `homepage`, `allowed-tools`, `user-invocable`, `license`.
- Prefer noun-phrase descriptions; short generic trigger phrase, not full workflow.
- Move long examples/docs to `references/`; scripts to `scripts/`; templates/media to `assets/`.
- No extra README/changelog/setup docs inside a skill unless they are actual task references.
- Validate YAML frontmatter after edits.

## Shape

```text
skill-name/
  SKILL.md
  scripts/      optional deterministic helpers
  references/   optional docs loaded only when needed
  assets/       optional output resources/templates
  agents/       optional UI metadata
```

## Good SKILL.md

```markdown
---
name: pdf-tools
description: "Inspect, split, merge, OCR, redact, or convert PDFs with local CLI tools."
---

# PDF tools

Use for PDF manipulation. Prefer deterministic scripts for page edits.

## Workflow

1. Inspect file/page count.
2. Choose exact operation.
3. Write output beside input unless user asked otherwise.
4. Render/verify changed pages.
```

## Edit workflow

1. Read existing skill and nearby resource names.
2. Remove generic advice the base model already knows.
3. Keep brittle command syntax, auth caveats, safety rules, and validation.
4. Replace tables with bullets unless a table is clearly needed.
5. Relax prose; fragments ok.
6. Validate frontmatter and run any script tests touched.

## Validation

```bash
python skills/skill-creator/scripts/quick_validate.py skills/<name>
python - <<'PY'
from pathlib import Path
import yaml
for p in Path("skills").glob("*/SKILL.md"):
    text=p.read_text()
    if not text.startswith("---\n"):
        raise SystemExit(f"missing frontmatter: {p}")
    fm=text.split("---",2)[1]
    yaml.safe_load(fm)
print("ok")
PY
```

`quick_validate.py` is conservative; repo-local frontmatter may allow keys beyond public skill bundles.
