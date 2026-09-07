---
name: skill-creator
description: "Author or review AgentSkills: create, repair, validate, or restructure SKILL.md files and bundled resources."
---

# Skill Creator

## Workflow

1. Establish the contract.
   - Read the existing skill and its resources, or collect concrete requests for a new skill.
   - Separate actual workflow branches from synonyms for the same branch.
   - **Done when:** every branch has a concrete trigger, expected outcome, and persistence target.

2. Choose invocation.
   - Model-discoverable: write a model-facing `description`; omit `disable-model-invocation`.
   - Manual-only: set `disable-model-invocation: true`; write a human-facing summary.
   - Direct tool command: add `command-dispatch: tool`, `command-tool`, and `command-arg-mode` only when the command bypasses the model.
   - **Done when:** frontmatter matches how the skill will actually be reached.

3. Structure the skill.
   - Map shared ordered procedure to `SKILL.md`; end every step with a checkable completion criterion and finish with verification.
   - Keep routing conditions in `description`; start the body with execution.
   - Map branch-only detail to `references/`, deterministic helpers to `scripts/`, output resources to `assets/`, and optional UI metadata to `agents/`.
   - **Done when:** every planned resource has one purpose and a direct pointer from `SKILL.md`.

4. Draft and persist.
   - Live workspace skill: use `skill_workshop` to create or revise a pending proposal; keep live files unchanged until apply.
   - Repository-owned skill source: use the repository's normal edit and review workflow.
   - **Done when:** the proposal or source diff implements every branch from step 1 and contains every resource from step 3.

5. Validate.
   - Run `python {baseDir}/scripts/quick_validate.py <skill-directory>` and execute every touched helper's focused test.
   - **Done when:** frontmatter passes, resource pointers resolve, and every touched helper passes its focused test.

## Frontmatter

Required: `name`, `description`.

OpenClaw also supports `metadata`, `homepage`, `license`, `allowed-tools`, `user-invocable`, `disable-model-invocation`, `command-dispatch`, `command-tool`, and `command-arg-mode`. Add optional fields only when they change runtime behavior or discovery.
