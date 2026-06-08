---
title: "Channel framework - Channel Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Channel Setup Maturity Note

## Summary

The channel setup surface is broadly implemented and actively used. It has a docs index for supported channels, a manifest-driven catalog for bundled and external channel plugins, trusted catalog filtering, setup-time install flows, first-run channel selection, account setup adapters, and CLI status/list surfaces that distinguish configured, available, and installable channels.

The main maturity limit is not absence of a framework. It is that the surface still has several active operational sharp edges: the docs/catalog relationship is not fully generated or enforced, setup-safe metadata boundaries are still being hardened, and install-on-demand/channel setup behavior has a recent record of regressions or maintainer confusion.

## Category Scope

Included in this category:

- Supported channel catalog: Supported channel catalog and docs index
- Channel status taxonomy in channels list: Channel status taxonomy in channels list, channels status, and setup status output
- Setup/onboarding flows: Setup/onboarding flows, including first-run channel selection and channel account setup
- Install-on-demand: Install-on-demand, downloadable, bundled, official external, local, npm, and ClawHub distinctions
- Setup wizard metadata: Setup wizard metadata and setup-safe plugin entrypoints

## Features

- Supported channel catalog: Supported channel catalog and docs index
- Channel status taxonomy in channels list: Channel status taxonomy in channels list, channels status, and setup status output
- Setup/onboarding flows: Setup/onboarding flows, including first-run channel selection and channel account setup
- Install-on-demand: Install-on-demand, downloadable, bundled, official external, local, npm, and ClawHub distinctions
- Setup wizard metadata: Setup wizard metadata and setup-safe plugin entrypoints

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - The docs index enumerates the supported channel set and explicitly marks several delivery/install distinctions, including WhatsApp install-on-demand and bundled/downloadable/external channel labels (`docs/channels/index.md:18`, `docs/channels/index.md:28`, `docs/channels/index.md:30`).
  - Source coverage spans catalog construction, official/external fallback catalogs, installed/installable setup buckets, trusted workspace fallback, first-run setup wizard selection, `channels add`, `channels list`, and `channels status` (`src/channels/plugins/catalog.ts:418`, `src/commands/channel-setup/discovery.ts:69`, `src/commands/channel-setup/trusted-catalog.ts:82`, `src/wizard/setup.ts:783`, `src/flows/channel-setup.ts:112`, `src/commands/channels/list.ts:144`, `src/commands/channels/status.ts:78`).
  - Docker E2E coverage verifies npm tarball onboarding, `channels add`, status surfaces, `doctor`, and an agent turn for Telegram/Discord/Slack (`scripts/e2e/npm-onboard-channel-agent-docker.sh:147`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:164`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:168`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:184`).
  - A bundled plugin Docker smoke exercises bundled plugin install/uninstall sweep entrypoints (`scripts/e2e/bundled-plugin-install-uninstall-docker.sh:33`, `scripts/e2e/bundled-plugin-install-uninstall-docker.sh:40`).
- Negative signals:
  - Real Docker flow evidence is concentrated on a small set of common channels rather than the full catalog.
  - The broad setup matrix is mostly covered through unit/E2E-harness tests rather than live external service setup for every official external channel.
  - Status taxonomy and docs-path correctness are tested in pieces, but there is no single end-to-end proof that every catalog docs path has a corresponding docs page and first-run setup path.
- Integration gaps:
  - No full-catalog live sweep that attempts setup/list/status for every installable official external channel.
  - No evidence that every per-channel docs page is generated or checked directly from catalog metadata.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - The archive shows active channel catalog additions and setup hardening work, including PR #81736 for a new official external channel catalog entry and PR #86953 for untrusted workspace setup-only channel loading.
  - Search results also show adjacent onboarding/catalog mismatch work and a WhatsApp channel issue, but no broad current cluster solely about the catalog/setup framework.
- Discrawl reports:
  - Maintainer discussion on 2026-04-24 called out that setup discovery/status/catalog loads should stay lightweight, while explicit selected onboarding/setup may need runtime dependency preparation for WhatsApp.
  - Review comments on PR #62934 and PR #50596 reported missing docs pages for advertised `docsPath` metadata, causing catalog/setup "Learn more" links to 404.
  - Security discussion on PR #86953 described a disabled workspace setup-only plugin execution gap and the fail-closed hardening path.
- Good qualities:
  - Catalog resolution is manifest-backed and merges discovered, official fallback, and external catalog entries with explicit priority rules (`src/channels/plugins/catalog.ts:421`, `src/channels/plugins/catalog.ts:452`, `src/channels/plugins/catalog.ts:460`).
  - Trusted catalog helpers prevent untrusted workspace shadows from being selected by normal setup/add flows while preserving setup discovery where appropriate (`src/commands/channel-setup/trusted-catalog.ts:17`, `src/commands/channel-setup/trusted-catalog.ts:56`, `src/commands/channel-setup/trusted-catalog.ts:90`).
  - Install choices are modeled explicitly as ClawHub, npm, local, and skip, with bundled local-path hiding to avoid misleading download prompts (`src/commands/onboarding-plugin-install.ts:42`, `src/commands/onboarding-plugin-install.ts:345`, `src/commands/onboarding-plugin-install.ts:361`).
  - Setup wizard docs tell plugin authors to use setup-safe entrypoints and optional-install surfaces rather than runtime-heavy channel loads (`docs/plugins/sdk-channel-plugins.md:199`, `docs/plugins/sdk-channel-plugins.md:218`, `docs/plugins/sdk-channel-plugins.md:241`).
- Bad qualities:
  - The docs index and per-channel docs path relationship remains partly convention-driven; archive evidence shows reviewers catching missing docs pages after metadata was introduced.
  - Setup-safe control-plane boundaries are still being refined, especially for setup-only plugin loading, runtime dependency preparation, and workspace trust.
  - Operator status concepts are useful but spread across docs, source formatters, plugin snapshots, and CLI JSON fields rather than presented as one canonical taxonomy.
- Excluded from quality:
  - Test and E2E proof were scored only under Coverage.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Supported channel catalog, Channel status taxonomy in channels list, Setup/onboarding flows, Install-on-demand, Setup wizard metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a catalog/docs consistency gate that checks every catalog `docsPath` against a real page, or generate the docs index from catalog metadata.
- Finish the metadata-first setup boundary so setup discovery/status/catalog paths do not need runtime-heavy imports except where the selected channel explicitly requires them.
- Expand live or Docker flow coverage beyond Telegram/Discord/Slack and the bundled sweep to representative official external install-on-demand channels.
- Consolidate the operator-facing status taxonomy for installed/available/installable/configured/enabled/linked/running/connected into a docs table tied to CLI JSON fields.
- Make first-run setup behavior for skipped or failed install-on-demand selections visibly consistent across provider and channel paths.

## Evidence

### Docs

- `docs/channels/index.md:9` describes channels as Gateway-connected chat apps; `docs/channels/index.md:18` documents WhatsApp as install-on-demand; `docs/channels/index.md:28` starts the supported channel catalog; `docs/channels/index.md:30` through `docs/channels/index.md:54` list Discord, Feishu, Google Chat, iMessage, IRC, LINE, Matrix, Mattermost, Teams, Nextcloud Talk, Nostr, QQ Bot, Signal, Slack, Synology Chat, Telegram, Tlon, Twitch, Voice Call, WebChat, WeChat, WhatsApp, Yuanbao, Zalo, and Zalo Personal.
- `docs/channels/index.md:58` through `docs/channels/index.md:64` explain simultaneous channels, fastest setup guidance, group behavior, pairing/allowlist enforcement, troubleshooting, and separate provider docs.
- `docs/channels/pairing.md:18` through `docs/channels/pairing.md:48` document DM pairing behavior, pairing code approval commands, and supported pairing channels.
- `docs/channels/troubleshooting.md:11` through `docs/channels/troubleshooting.md:29` define the basic channel troubleshooting ladder and healthy status baseline; `docs/channels/troubleshooting.md:49` through `docs/channels/troubleshooting.md:160` provide per-channel troubleshooting signatures.
- `docs/plugins/sdk-channel-plugins.md:199` through `docs/plugins/sdk-channel-plugins.md:245` define setup-safe SDK surfaces, `openclaw.setupEntry`, optional channel setup surfaces, and install-required behavior for setup surfaces.

### Source

- `src/channels/plugins/catalog.ts:23` through `src/channels/plugins/catalog.ts:50` define UI/catalog entry shapes, install metadata, origin, and trusted-source flags.
- `src/channels/plugins/catalog.ts:78` through `src/channels/plugins/catalog.ts:129` resolve external catalog paths from env/config defaults; `src/channels/plugins/catalog.ts:189` through `src/channels/plugins/catalog.ts:223` resolve official catalog file candidates and built-in official external entries.
- `src/channels/plugins/catalog.ts:255` through `src/channels/plugins/catalog.ts:323` derive install source defaults and npm/ClawHub/local path metadata; `src/channels/plugins/catalog.ts:325` through `src/channels/plugins/catalog.ts:371` builds catalog entries from plugin manifests.
- `src/channels/plugins/catalog.ts:418` through `src/channels/plugins/catalog.ts:483` merges discovered, official fallback, and external catalog entries with origin/fallback priority and display sorting.
- `src/channels/bundled-channel-catalog-read.ts:36` through `src/channels/bundled-channel-catalog-read.ts:60` reads bundled extension package metadata fail-soft; `src/channels/bundled-channel-catalog-read.ts:122` through `src/channels/bundled-channel-catalog-read.ts:141` merges bundled package metadata with official catalog fallback.
- `src/channels/chat-meta-shared.ts:36` through `src/channels/chat-meta-shared.ts:54` builds the bundled chat-channel metadata map from bundled channel catalog entries.
- `src/channels/plugins/types.core.ts:178` through `src/channels/plugins/types.core.ts:201` define `ChannelMeta` fields used by docs, pickers, and setup surfaces; `src/channels/plugins/types.core.ts:203` through `src/channels/plugins/types.core.ts:269` define status snapshot fields.
- `src/commands/channel-setup/discovery.ts:69` through `src/commands/channel-setup/discovery.ts:178` resolves installed and installable catalog entries and merges bundled/plugin/catalog metadata into setup picker entries.
- `src/commands/channel-setup/trusted-catalog.ts:17` through `src/commands/channel-setup/trusted-catalog.ts:53` gate untrusted workspace catalog entries; `src/commands/channel-setup/trusted-catalog.ts:82` through `src/commands/channel-setup/trusted-catalog.ts:96` expose trusted and setup-discovery catalog lists.
- `src/wizard/setup.ts:783` through `src/wizard/setup.ts:803` calls channel setup during first-run onboarding, with quickstart defaults and deferred status behavior.
- `src/flows/channel-setup.ts:112` through `src/flows/channel-setup.ts:254` preloads configured external plugins, collects setup status, confirms setup, and shows a channel primer; `src/flows/channel-setup.ts:323` through `src/flows/channel-setup.ts:358` adds installable catalog selection hints; `src/flows/channel-setup.ts:580` through `src/flows/channel-setup.ts:713` handles catalog install, stale external channel recovery, and bundled-plugin enablement.
- `src/commands/onboarding-plugin-install.ts:303` through `src/commands/onboarding-plugin-install.ts:342` resolves install defaults; `src/commands/onboarding-plugin-install.ts:345` through `src/commands/onboarding-plugin-install.ts:441` builds ClawHub/npm/local/skip install prompts and hides remote options for bundled local sources.
- `src/commands/channels/list.ts:125` through `src/commands/channels/list.ts:142` formats catalog-only installed/configured/enabled status; `src/commands/channels/list.ts:238` through `src/commands/channels/list.ts:300` distinguishes configured, available, and installable channel origins.
- `src/commands/channels/status.ts:78` through `src/commands/channels/status.ts:212` formats live gateway channel status bits; `src/commands/channels/status-config-format.ts:34` through `src/commands/channels/status-config-format.ts:143` formats config-only fallback status and missing official external plugin repair hints.

### Integration tests

- `scripts/e2e/npm-onboard-channel-agent-docker.sh:27` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:33` parameterizes the Docker E2E over Telegram, Discord, and Slack.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:147` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:171` runs non-interactive onboarding, verifies package-mode dependency absence/presence, runs `openclaw channels add`, and checks `channels status`/`status` surfaces.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:173` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` runs doctor, configures a mocked model, and verifies a local agent turn after channel setup.
- `scripts/e2e/bundled-plugin-install-uninstall-docker.sh:33` through `scripts/e2e/bundled-plugin-install-uninstall-docker.sh:47` runs the bundled plugin install/uninstall Docker sweep.
- `src/commands/onboard-channels.e2e.test.ts:624` through `src/commands/onboard-channels.e2e.test.ts:660` verifies Telegram setup continues when the plugin registry is empty; `src/commands/onboard-channels.e2e.test.ts:827` through `src/commands/onboard-channels.e2e.test.ts:872` keeps configured external plugin channels visible; `src/commands/onboard-channels.e2e.test.ts:919` through `src/commands/onboard-channels.e2e.test.ts:945` treats installed external plugin channels as installed without reinstall prompts.

### Unit tests

- `src/channels/plugins/contracts/channel-catalog.contract.test.ts:7` through `src/channels/plugins/contracts/channel-catalog.contract.test.ts:50` checks catalog entries for Teams, WhatsApp, WeCom, and Yuanbao; `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:31` through `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:49` verifies shipped catalog alignment and listing.
- `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:52` through `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:101` covers bundled metadata-only catalog entries; `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:104` through `src/channels/plugins/contracts/test-helpers/channel-catalog-contract.ts:260` covers official fallback entries, external catalog override, and package-name drift warnings.
- `src/channels/bundled-channel-catalog-read.test.ts:99` through `src/channels/bundled-channel-catalog-read.test.ts:244` covers bundled metadata reads, official catalog fallback, stale generated metadata precedence, and empty/missing bundled dir fallback; `src/channels/bundled-channel-catalog-read.fail-soft.test.ts:9` through `src/channels/bundled-channel-catalog-read.fail-soft.test.ts:25` verifies fail-soft discovery.
- `src/commands/channel-setup/discovery.test.ts:57` through `src/commands/channel-setup/discovery.test.ts:102` verifies auto-enabled manifest discovery; `src/commands/channel-setup/discovery.test.ts:104` through `src/commands/channel-setup/discovery.test.ts:180` covers hidden setup entries and metadata preservation.
- `src/commands/channel-setup/plugin-install.test.ts:471` through `src/commands/channel-setup/plugin-install.test.ts:651` covers install defaults for dev/beta, bundled local path behavior, non-interactive bundled install, external catalog override, and ClawHub-first install source prompts; `src/commands/channel-setup/plugin-install.test.ts:681` through `src/commands/channel-setup/plugin-install.test.ts:719` covers auto-confirmed single-source install.
- `src/commands/channels.list.test.ts:345` through `src/commands/channels.list.test.ts:538` verifies default/`--all` text and JSON behavior for configured, available, and installable catalog channels; `src/commands/channels.list.test.ts:540` through `src/commands/channels.list.test.ts:580` verifies installed-on-disk catalog channels remain visible when no plugin object is loaded.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel catalog setup onboarding" --json --limit 10`

Results:

- Returned PR #81736, "feat(catalog): add DingTalk to official external channel catalog", showing ongoing catalog expansion.
- Returned PR #86953, "fix(plugins): block untrusted workspace setup-only channel loads", showing active hardening around trusted catalog filtering and setup-only channel setup.
- Returned PR #70012 indirectly through archive-adjacent terms in other searches and issue #73496 for a WhatsApp runtime hang after onboarding; no broad cluster of current catalog-only user bugs appeared.

Query: `gitcrawl search openclaw/openclaw --query "docsPath channel catalog setup" --json --limit 10`

Results:

- Returned PR #81736 only, suggesting docsPath/catalog setup issues are not a broad standalone gitcrawl cluster, though discrawl found review comments on missing docs pages.

Query: `gitcrawl search openclaw/openclaw --query "install on demand channel setup wizard plugin not available" --json --limit 10`

Results:

- Returned no hits, which is neutral after freshness checks; it did not surface a current open issue cluster for that exact setup failure wording.

Query: `gitcrawl search openclaw/openclaw --query "channels list installable not installed catalog" --json --limit 10`

Results:

- Returned PR #86953, with a snippet that catalog callers should resolve channels through trusted helpers so setup/add flows do not select untrusted workspace shadows.

Query: `gitcrawl search openclaw/openclaw --query "setup-only channel loads untrusted workspace" --json --limit 10`

Results:

- Returned PR #86953, confirming the untrusted workspace setup-only loading issue is a feature-specific quality signal.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "channel catalog setup onboarding"`

Results:

- Found a 2026-05-12 maintainer/contributor message about PR #80645 adding i18n support for the CLI setup/onboarding wizard and localized channel setup prompts.
- Found a 2026-04-24 maintainer discussion distinguishing setup discovery/status/catalog loads from explicit selected onboarding/setup, with WhatsApp runtime dependency concerns.
- Found review comments on PR #70012 about install-on-demand retry handling and a PR summary for auto-installing missing provider/channel plugins during onboarding.
- Found an architecture refactor note stating setup/control-plane flows should become metadata-first and that setup/config paths still import plugin code in cases that should be metadata-only.
- Found review comments on PR #67693, #62934, and #50596 about bundled channel/catalog metadata, prompt hardening, and missing docs pages for advertised `docsPath` metadata.

Query: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "setup-only channel loads untrusted workspace"`

Results:

- Found maintainer security discussion on PR #86953 explaining that disabled workspace channel plugins still executed during setup-scoped loads and that the fix should fail closed.
- Found review comments on PR #64154 about not treating untrusted workspace catalog entries as add targets and preserving scoped workspace setup plugin loadability for add flows.

Query: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "channel docsPath catalog setup 404"`

Results:

- Found PR #62934 review comment that `openclaw.channel.docsPath` pointed to `/channels/eclaw` without a matching docs page, causing catalog/setup "Learn more" links to 404.
- Found PR #50596 review comment with the same missing-docs-page issue for a new Utopia channel metadata entry.

Query: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "install on demand channel setup wizard"`

Results:

- Found PR #70012 review comment that install-on-demand skip/failure retry handling could let setup continue incorrectly in the provider/auth loop; this is adjacent evidence for shared onboarding installer behavior.
