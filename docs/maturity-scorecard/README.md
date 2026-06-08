---
title: Maturity scorecard process
version: 3
---

# Maturity scorecard process

This directory is an artifact root maintained by the local `claw-score` skill
defined in the external `claw-score` `SKILL.md`.

The skill owns scoring policy, scoring workflow, validation, artifact shape,
and renderer expectations. This README is the human-facing directory contract
and process overview.

The top-level scorecard layout is owned by the skill template
`.agents/skills/claw-score/references/maturity-scorecard-template.md`, then
rendered into [maturity-scorecard.md](maturity-scorecard.md).

Operationally, the skill separates three workflows: taxonomy maintenance, score
computation, and skill self-maintenance. The detailed agent instructions for
those live in the skill reference files, not in this README.

## Source files

- `taxonomy.yaml` is the source of truth for surfaces, maturity levels,
  surface ids, category definitions, category `human_lts_override` values,
  category `docs` reading lists, surface `completeness_instructions`, and
  `last_score_run` provenance for the active in-repo surfaces.
- `/Users/kevinlin/tmp/maturity/taxonomy.yaml` stores the archived taxonomy for
  the other surfaces that are temporarily out of the active in-repo scope.
- `<artifact-root>/<surface>/scores.yaml` is the per-surface score source for
  Coverage, Quality, Completeness, and row identity (`name` and
  `category_note`). The renderer joins taxonomy-owned category metadata from
  `taxonomy.yaml`. Active artifact paths are derived by naming convention from
  the taxonomy surface id: `inventory/<surface-id>/report.md`,
  `inventory/<surface-id>/scores.yaml`, and `inventory/<surface-id>/<category-note>`.
  Historical archived surfaces live at `/Users/kevinlin/tmp/maturity` and are
  intentionally skipped by the normal `claw-score` render and sync workflows.
- [maturity-scorecard.md](maturity-scorecard.md), [taxonomy.md](taxonomy.md),
  [taxonomy-outline.md](taxonomy-outline.md), and
  `<artifact-root>/<surface>/report.md` are rendered Markdown artifacts. Do not
  hand-edit their generated tables.

## Directory layout

```text
docs/kevinslin/maturity-scorecard/
├── README.md
├── taxonomy.md
├── taxonomy-outline.md
├── maturity-scorecard.md
└── inventory/
    ├── gateway-runtime/
    │   ├── report.md
    │   ├── <category>.md
    │   └── scores.yaml
    └── plugin-sdk-and-bundled-plugin-architecture/
        ├── report.md
        ├── <category>.md
        └── scores.yaml
```

Interpret these files as follows:

- `README.md`: human-facing process overview and artifact contract.
- `taxonomy.md`: rendered taxonomy reference generated from the skill-owned
  taxonomy YAML.
- `taxonomy-outline.md`: rendered surface outline grouped by family, generated
  from the skill-owned taxonomy YAML.
- [maturity-scorecard.md](maturity-scorecard.md): rendered top-level scorecard generated from the
  skill-owned taxonomy.
- `inventory/`: canonical artifact root for active maturity-scorecard work.
- `/Users/kevinlin/tmp/maturity`: archive location for historical artifact
  trees and the archived taxonomy file. Treat it as out of scope unless
  explicitly restoring archived work.
- `<artifact-root>/<surface>/scores.yaml`: per-surface score source generated or
  refreshed by the skill.
- `<artifact-root>/<surface>/report.md`: rendered surface report.
- `<artifact-root>/<surface>/<category>.md`: per-category evidence note.

## Concepts

- `taxonomy`: the skill-owned YAML file that defines the top-level maturity
  model, surface inventory, per-surface category metadata, and `last_score_run`
  state.
- `scorecard`: the rendered top-level Markdown overview generated from the
  taxonomy. Its generated table includes per-surface Coverage, Quality,
  Completeness, and LTS status columns derived from `scores.yaml` plus
  taxonomy `human_lts_override` metadata.
- `taxonomy doc`: the rendered Markdown reference view of the taxonomy,
  including the surface inventory and per-surface categories.
- `taxonomy outline`: the rendered Markdown outline of active surfaces grouped
  by family.
- `surface`: one scored product or platform area from the taxonomy.
- `surface slug`: the stable filesystem-friendly identifier used for a
  surface's inventory directory and filenames.
- `artifact root`: the per-surface parent directory selected in taxonomy
  naming convention. Active work currently uses `inventory/<surface-id>/`;
  archived surfaces are marked in taxonomy with `archived: true`.
- `category`: a significant user-facing or operator-facing part of a surface
  that gets its own evidence note and row in the per-surface score YAML. A
  category should represent a capability area a user can actually utilize, not
  an internal implementation bucket.
- `category note`: the per-category Markdown evidence artifact
  `<artifact-root>/<surface>/<category>.md`. Notes include a taxonomy-derived
  `## Features` section that mirrors the category feature list from
  `taxonomy.yaml`.
- `scores.yaml`: the canonical per-surface score source
  `<artifact-root>/<surface>/scores.yaml`; it stores Coverage, Quality,
  Completeness, and row identity, while taxonomy owns features, docs, search
  anchors, `human_lts_override`, and surface-level
  `completeness_instructions`.
- `LTS.md`: hand-curated initial LTS slice. Its status rows must stay
  synchronized with taxonomy `human_lts_override` values and rendered
  per-surface report matrix LTS cells by running
  `.agents/skills/claw-score/scripts/validate_lts_sync.py`.
- `completeness_instructions`: taxonomy-owned surface metadata pointing to a
  skill-relative rubric file under `.agents/skills/claw-score/` that explains
  how to score Completeness for that surface.
- `features`: taxonomy-owned category metadata stored as objects with `name`
  and `description`. Keep `name` short and scannable; put the fuller
  explanation in `description`. A feature should be a user-invokable
  capability for that surface/category, not a handshake step or other
  implementation-only detail.
- `docs`: taxonomy-owned category metadata listing repo-relative doc URLs that
  best cover the category. Keep this as a short primary-reading list, not a
  full evidence dump. During taxonomy maintenance, this list should be chosen
  by scanning the OpenClaw docs corpus for the category and selecting the
  canonical pages a reviewer should open first.
- `surface report`: the rendered per-surface Markdown report
  `<artifact-root>/<surface>/report.md`.

Category display names should be short, operator-facing capability names.
Prefer fewer coarser categories, merge related concepts that share docs and
operator workflows, and keep old or implementation-heavy terminology in
`search_anchors`, feature descriptions, or evidence rather than in the display
name.

## Versioning

Markdown scorecard artifacts use frontmatter `version` for the scoring process
that produced that document.

During a real rescore, the surface report and category notes should have
frontmatter `version` equal to the active `scores.yaml process_version`.

YAML sources use:

- `version`: schema version for the file shape. This starts at `1`.
- `process_version`: scoring process version. Current scoring runs use `3`.

Do not bulk-update existing per-surface `last_score_run.process_version` or
`scores.yaml process_version` for render-only, taxonomy-only, or mechanical doc
changes. Update a surface's scoring provenance when that surface is actually
rescored with refreshed evidence.

## LTS

LTS is generated, not scored by category agents.

The renderer marks a category as LTS when either condition is true:

- `quality > 80 and coverage > 90`
- the matching taxonomy category sets `human_lts_override: true`

Keep `human_lts_override` in `taxonomy.yaml`. Do not write it into
`scores.yaml`.

## Regeneration

Use the skill scripts from the repository root:

```bash
python3 .agents/skills/claw-score/scripts/sync_taxonomy_categories.py \
  --taxonomy .agents/skills/claw-score/taxonomy.yaml \
  --scorecard-root docs/kevinslin/maturity-scorecard

python3 .agents/skills/claw-score/scripts/sync_scores_yaml.py \
  --taxonomy .agents/skills/claw-score/taxonomy.yaml \
  --scorecard-root docs/kevinslin/maturity-scorecard

python3 .agents/skills/claw-score/scripts/render_taxonomy_from_taxonomy.py \
  --taxonomy .agents/skills/claw-score/taxonomy.yaml \
  --taxonomy-doc docs/kevinslin/maturity-scorecard/taxonomy.md \
  --taxonomy-outline-doc docs/kevinslin/maturity-scorecard/taxonomy-outline.md

python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
  --taxonomy .agents/skills/claw-score/taxonomy.yaml \
  --scorecard docs/kevinslin/maturity-scorecard/maturity-scorecard.md
```

Use each command's `--check` mode before handoff when verifying artifacts.

If the skill's renderers, sync scripts, or templates change, rerun the relevant
commands above and update this README in the same change when the artifact
contract or regeneration guidance changes.

## Editing rules

- For scoring, rescoring, audits, taxonomy changes, report regeneration, or
  output-shape changes, use `claw-score`.
- When updating the `claw-score` skill itself, update the relevant source
  files under `.agents/skills/claw-score/` and keep this README aligned with
  any artifact-contract, terminology, or regeneration changes.
- Do not hand-edit generated tables or inventories in `taxonomy.md` or
  `taxonomy-outline.md`; rerender them through the skill scripts.
- Do not hand-edit generated score tables in `maturity-scorecard.md` or
  `<artifact-root>/<surface>/report.md`; rerender them through the skill
  scripts. That includes the report's feature lists, which are rendered from
  taxonomy.
- Do not hand-edit taxonomy-derived `## Features` sections in category notes;
  update `taxonomy.yaml` and rerender the owning surface report instead.
- Keep agent instructions in the external `claw-score` `SKILL.md`, not in this
  directory.
