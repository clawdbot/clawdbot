---
name: localize-openclaw
description: Add, change, review, or validate OpenClaw product-owned localized text and locale catalogs. Use for user- or operator-visible copy in CLI, TUI, Control UI, native apps, Gateway presentation, channels, plugins, skills, or docs; for adopting a new localization surface; for changing English source messages; or for adding a locale.
---

# Localize OpenClaw

Keep message meaning and English source with the product surface. Reuse the shared locale, context, fallback, validation, and literal-safety contracts; do not centralize surface catalogs.

## Classify the text

Localize product-owned presentation only. Do not translate:

- commands, flags, config keys, protocol fields, status/error codes, paths, IDs, PIDs, versions, or provider names;
- user-authored or model-generated content;
- upstream error text, logs, or developer-only diagnostics; or
- structured output keys or canonical values.

Preserve structured modes such as `--json` exactly. Localize the human renderer at the presentation edge, after business logic has produced structured facts.

## Identify ownership

Before editing, locate:

1. the product owner for message meaning and reviewed English;
2. the rendering owner for locale selection, escaping, and presentation; and
3. the surface-owned catalog, generator, and focused validation command.

Extend an existing owner boundary. If the surface is not enrolled, add one bounded owner declaration and its scoped gate as part of the slice; do not create a second shared runtime or a global catalog.

Ask the owning maintainer before changing approval, authentication, authorization, destructive-action, privacy, recovery, Gateway protocol, channel safety, Plugin SDK, command metadata, or skill metadata copy.

## Implement a message

1. Resolve one immutable `LocalizationContext` at the surface operation or session entry and propagate it through nested renderers.
2. Use a stable namespaced semantic key such as `cli.update.dryRun.channel`.
3. Keep reviewed English as the source catalog entry and whole-message emergency fallback.
4. Pass operational values as literal parameters. Put product-owned modes or labels in catalog text or bounded selectors.
5. Render only at the final presentation edge. Delete the superseded hardcoded or parsed-prose path after proof.
6. Update translations through the surface-owned workflow. Treat generated text as a candidate requiring the normal product/safety review.

For process-owned surfaces, `OPENCLAW_LOCALE` is a strict explicit override. An invalid explicit value falls directly to English. Without it, evaluate `LC_ALL`, `LC_MESSAGES`, then `LANG`; retain rejected inputs and continue until a supported inferred locale is found. `C` and `POSIX` select English.

## Use the bounded ICU profile

Catalog messages may use:

- plain text and named arguments such as `{path}`;
- one top-level cardinal `plural` or `select`;
- CLDR plural categories; and
- an `other` branch for every selector.

Do not use ordinal or exact-number selectors, nested selectors, `#`, rich-text tags, or ICU number/date/time formatting. Preserve placeholder names in every branch. Preserve source case names for `select`; target plurals may use the target language categories. Do not place bidirectional controls in catalog text. Use renderer-owned literal isolation for embedded operational values in bidirectional output.

## Change English source

Treat every English edit as a new source revision:

1. update the English catalog and owner glossary if present;
2. refresh all locales through the owner workflow;
3. verify placeholders, selectors, and protected literals;
4. update intentional snapshots; and
5. run the scoped catalog gate and renderer tests.

Keeping the same key does not make an older translation current.

## Add a locale

Update `OPENCLAW_LOCALES`, `OPENCLAW_LOCALE_REGISTRY`, aliases, fallback, direction, the registry revision digest, and focused registry tests. Then enroll the locale only in surfaces that own a catalog and can prove fallback. Registry membership does not claim product-wide translation coverage.

Add representative shaping, segmentation, expansion, and bidirectional fixtures when the script requires them.

## Validate the owning surface

Use the nearest existing workflow:

- Control UI: `pnpm ui:i18n:baseline` and `pnpm ui:i18n:verify`
- Wizard/onboarding: `node scripts/run-vitest.mjs src/wizard/i18n/index.test.ts`
- Native apps: `pnpm native:i18n:baseline` and `pnpm native:i18n:verify`
- Documentation glossary: `pnpm docs:check-i18n-glossary`

If the repository has a localization owner registry and catalog gate, run its scoped check and refresh command for the adopted owner. Never hand-edit generated native catalogs, translated documentation trees, or translation-memory files.

Prove:

- reviewed English output;
- at least one non-English locale;
- unsupported-locale fallback;
- placeholder and protected-literal preservation;
- invalid descriptor/parameter behavior where applicable;
- exact structured-output equality; and
- privacy-safe diagnostics.

Then run the repository checks required by the changed files.
