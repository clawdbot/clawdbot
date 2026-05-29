---
summary: "Visual summary and technical evidence for the May 2026 performance, package-size, dependency, and shrinkwrap cleanup"
read_when:
  - You are validating the May 2026 performance and package-size cleanup
  - You need the numbers behind the OpenClaw performance and dependency blog post
  - You are changing release gates, package shrinkwrap, or plugin dependency boundaries
title: "Release performance sweep"
---

This page captures the evidence behind the May 2026 OpenClaw performance,
package-size, dependency, and shrinkwrap cleanup. It is the technical companion
to the public blog post.

Two audits are combined here:

- **Release performance sweep:** GitHub Releases from `v2026.5.27` back through
  stable `v2026.4.23`, using the `OpenClaw Performance` workflow,
  `profile=smoke`, `repeat=1`, mock-provider lane.
- **Earlier April context:** published `clawgrit-reports` mock-provider
  baselines from `v2026.4.1` through `v2026.5.2`, used only to avoid treating
  the broken late-April releases as the public performance baseline.
- **Install footprint sweep:** fresh `npm install --ignore-scripts` installs
  into temporary packages, with `du -sk node_modules` for size and a
  `node_modules` walk for package-instance counts.
- **npm package size sweep:** `npm pack openclaw@<version> --dry-run --json`
  for published releases, recording compressed tarball size, unpacked size, and
  file count.

<Warning>
The main performance sweep uses one smoke sample per tag. Earlier April context
uses published repeat-3 medians from `clawgrit-reports`. Treat the numbers as
trend evidence and regression-hunting signal, not as release-gate statistics.
</Warning>

## Snapshot

Performance coverage: **76 requested releases**, **73 artifact-backed points**,
and **3 unavailable CI runs**. Latest stable measured point: `v2026.5.27`.

<CardGroup cols={2}>
  <Card title="Stable agent turn" icon="gauge">
    **2.9x faster cold turn**

    - `v2026.4.14`: 9.8s
    - `v2026.5.27`: 3.4s

  </Card>
  <Card title="Published package" icon="package">
    **17.8MB tarball**

    Latest stable package, down from the 43.3MB March package-size peak.

  </Card>
  <Card title="Latest stable install" icon="hard-drive">
    **786.9MB fresh install**

    `v2026.5.27` still contains the nested OpenClaw dependency tree. The
    next-release state on `main` is 407.4MB.

  </Card>
  <Card title="Dependency graph" icon="boxes">
    **371 installed packages**

    Latest stable release. Current `main` is down to 314 after the follow-up
    dependency cleanup.

  </Card>
</CardGroup>

## Install Footprint Timeline

<CardGroup cols={2}>
  <Card title="Monthly high" icon="triangle-alert">
    **645 dependencies**

    `2026.2.26` was the monthly dependency-count high in this sample.

  </Card>
  <Card title="Shrinkwrap introduced" icon="lock">
    **1,020.6MB install**

    `2026.5.22` added root shrinkwrap and exposed a package-shape problem:
    911.8MB landed under nested `openclaw/node_modules`.

  </Card>
  <Card title="Latest stable" icon="tag">
    **786.9MB install**

    `2026.5.27` reduced the peak but still installed a 675.9MB nested
    OpenClaw tree.

  </Card>
  <Card title="Next-release state" icon="scissors">
    **407.4MB install**

    Current `main` keeps shrinkwrap, removes the nested tree, and installs
    314 packages.

  </Card>
</CardGroup>

<Tip>
Shrinkwrap was not the problem by itself. The bad package shape was. Current
`main` still ships shrinkwrap, but npm no longer materializes a second
OpenClaw dependency tree during install.
</Tip>

## What Changed After 5.27

The cleanup between `v2026.5.27` and current `main` removed the duplicate
default-install graph instead of removing the capabilities themselves.

<CardGroup cols={2}>
  <Card title="Root default graph" icon="git-branch">
    Root shrinkwrap package paths fell from **372** to **331**. Unique package
    names fell from **357** to **318**.
  </Card>
  <Card title="Direct root dependencies" icon="unplug">
    `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
    `@earendil-works/pi-coding-agent`, and `pdfjs-dist` left the default root
    dependency path.
  </Card>
  <Card title="Native optional cones" icon="cpu">
    The all-platform `@napi-rs/canvas` and `@mariozechner/clipboard` native
    package cones stopped landing in the default install.
  </Card>
  <Card title="Supply-chain surface" icon="shield">
    Fewer default packages means fewer tarballs, maintainers, native binaries,
    install-time behaviors, and transitive update paths to trust by default.
  </Card>
</CardGroup>

## Headline Numbers

Do not use the late-April broken rows as public performance baselines.
`v2026.4.23` and `v2026.4.29` are useful regression evidence, but the large
`14x`-style deltas mostly describe the recovery from a bad release line.

For the blog narrative, use the earlier April published baseline as scale:

| Metric          | Earlier April baseline | `v2026.5.27` |                    Delta |
| --------------- | ---------------------: | -----------: | -----------------------: |
| Cold agent turn |                9,819ms |      3,378ms | 65.6% lower, 2.9x faster |
| Warm agent turn |                7,458ms |      2,973ms | 60.1% lower, 2.5x faster |
| Agent peak RSS  |                686.2MB |      635.5MB |               7.4% lower |

The earlier April baseline is `v2026.4.14` from the published
`clawgrit-reports` mock-provider run. That run used repeat 3 and failed only
because the diagnostic timeline was not emitted; the cold, warm, and RSS
medians are still useful as rough scale. Treat this as narrative context, not a
release-gate statistic.

Within the single-sample stable May sweep, the line moved more modestly:

| Metric          | `v2026.5.2` | `v2026.5.27` |       Delta |
| --------------- | ----------: | -----------: | ----------: |
| Cold agent turn |     3,897ms |      3,378ms | 13.3% lower |
| Warm agent turn |     3,610ms |      2,973ms | 17.6% lower |
| Agent peak RSS  |     613.7MB |      635.5MB | 3.6% higher |

Best prerelease point in the single-sample sweep:

| Metric          | `v2026.5.27` | `v2026.5.27-beta.1` |       Delta |
| --------------- | -----------: | ------------------: | ----------: |
| Cold agent turn |      3,378ms |             2,575ms | 23.8% lower |
| Warm agent turn |      2,973ms |             2,217ms | 25.4% lower |
| Agent peak RSS  |      635.5MB |             635.3MB |        flat |

### Install footprint

| Metric                                          |  Baseline | Current main |       Delta |
| ----------------------------------------------- | --------: | -----------: | ----------: |
| Install size from `2026.5.22` peak              | 1,020.6MB |      407.4MB | 60.1% lower |
| Install size from latest release `2026.5.27`    |   786.9MB |      407.4MB | 48.2% lower |
| Dependencies from monthly high `2026.2.26`      |       645 |          314 | 51.3% lower |
| Dependencies from latest release `2026.5.27`    |       371 |          314 | 15.4% lower |
| Nested `openclaw/node_modules` from `2026.5.22` |   911.8MB |          0MB |     removed |
| Nested `openclaw/node_modules` from `2026.5.27` |   675.9MB |          0MB |     removed |

### npm package size

| Version     | Compressed tarball | Unpacked package |  Files | Notes                             |
| ----------- | -----------------: | ---------------: | -----: | --------------------------------- |
| `2026.1.30` |             12.8MB |           33.5MB |  4,607 | early rebranded package           |
| `2026.2.26` |             23.6MB |           82.9MB | 10,125 | feature growth                    |
| `2026.3.31` |             43.3MB |          182.6MB | 21,037 | package-size high point           |
| `2026.4.29` |             22.9MB |           74.6MB |  9,309 | package pruning visible           |
| `2026.5.12` |             23.4MB |           80.1MB | 12,035 | major external-plugin split       |
| `2026.5.22` |             17.2MB |           76.9MB | 12,386 | docs/assets excluded from package |
| `2026.5.27` |             17.8MB |           79.0MB | 12,509 | latest stable package             |

`2026.5.12` is the visible plugin-extraction milestone in the changelog:
Amazon Bedrock, Bedrock Mantle, Slack, OpenShell sandbox, Anthropic Vertex,
Matrix, and WhatsApp moved out of the core dependency path so their dependency
cones install with those plugins instead of every core install.

## Kova agent turn summary

The April stable line contains two different stories. Earlier April was slow
but recognizable. Late April became a regression cliff. `v2026.5.2` is where
the mock-provider lane first drops into the 3-5s range and starts passing
consistently in the supplied sweep.

Earlier published context:

| Release      | Kova | Cold turn | Warm turn | Agent peak RSS |
| ------------ | ---- | --------: | --------: | -------------: |
| `v2026.4.10` | FAIL |  11,031ms |   7,962ms |        679.0MB |
| `v2026.4.12` | FAIL |  11,965ms |   8,289ms |        713.5MB |
| `v2026.4.14` | FAIL |   9,819ms |   7,458ms |        686.2MB |
| `v2026.4.20` | FAIL |  22,314ms |  18,811ms |        810.8MB |
| `v2026.4.22` | FAIL |   9,630ms |   7,459ms |        743.0MB |

Supplied single-sample sweep:

| Release             | Kova | Cold turn | Warm turn | Agent peak RSS |
| ------------------- | ---- | --------: | --------: | -------------: |
| `v2026.4.23`        | FAIL |  47,847ms |   8,010ms |      1,082.7MB |
| `v2026.4.24`        | FAIL |  48,264ms |  25,483ms |        996.0MB |
| `v2026.4.25`        | FAIL |  81,080ms |  59,172ms |      1,113.9MB |
| `v2026.4.26`        | FAIL |  76,771ms |  54,941ms |      1,140.8MB |
| `v2026.4.27`        | FAIL |  60,902ms |  33,699ms |      1,156.0MB |
| `v2026.4.29`        | FAIL |  94,031ms |  57,334ms |      3,613.7MB |
| `v2026.5.2`         | PASS |   3,897ms |   3,610ms |        613.7MB |
| `v2026.5.7`         | PASS |   3,923ms |   3,693ms |        654.1MB |
| `v2026.5.12`        | PASS |   7,248ms |   6,629ms |        834.8MB |
| `v2026.5.18`        | PASS |   3,301ms |   2,913ms |        630.3MB |
| `v2026.5.20`        | PASS |   3,413ms |   2,952ms |        643.2MB |
| `v2026.5.22`        | PASS |   4,494ms |   4,093ms |        654.3MB |
| `v2026.5.26`        | PASS |   2,626ms |   2,282ms |        660.4MB |
| `v2026.5.27-beta.1` | PASS |   2,575ms |   2,217ms |        635.3MB |
| `v2026.5.27`        | PASS |   3,378ms |   2,973ms |        635.5MB |

## Source probes

Source probes were skipped for 17 successful older refs because those source
trees did not yet have the required probe entry points. Agent-turn metrics still
exist for those refs.

Representative source-probe points:

| Release             | Default `readyz` p50 | 50 plugins `readyz` p50 | CLI health p50 | Plugin max RSS |
| ------------------- | -------------------: | ----------------------: | -------------: | -------------: |
| `v2026.4.29`        |              2,819ms |                 2,618ms |        1,679ms |        389.0MB |
| `v2026.5.2`         |              2,324ms |                 2,013ms |        1,384ms |        377.2MB |
| `v2026.5.7`         |              1,649ms |                 1,540ms |        1,175ms |        387.6MB |
| `v2026.5.18`        |              1,942ms |                 1,927ms |          607ms |        426.5MB |
| `v2026.5.20`        |              1,966ms |                 1,987ms |          621ms |        455.0MB |
| `v2026.5.22`        |              2,081ms |                 1,884ms |        5,095ms |        444.2MB |
| `v2026.5.26`        |              1,546ms |                 1,634ms |          656ms |        400.4MB |
| `v2026.5.27-beta.1` |              1,462ms |                 1,548ms |          548ms |        394.0MB |
| `v2026.5.27`        |              1,874ms |                 1,925ms |          660ms |        398.0MB |

The `v2026.5.22` CLI health spike is visible in this table even though the
agent-turn lane still passed. Keep the source probes when investigating
targeted CLI or gateway regressions.

## Install footprint audit

Dependency samples use one stable release per month, plus the
`2026.5.22` shrinkwrap-introduction event, latest `2026.5.27`, and current
`main`.

| Point              | Installed deps | Fresh install | OpenClaw package | Nested `openclaw/node_modules` | Root shrinkwrap | Canvas install behavior                   |
| ------------------ | -------------: | ------------: | ---------------: | -----------------------------: | --------------- | ----------------------------------------- |
| Jan `2026.1.30`    |            605 |       438.4MB |           45.8MB |                          2.4MB | no              | top-level wrapper + `darwin-arm64`        |
| Feb `2026.2.26`    |            645 |       575.7MB |          110.1MB |                          3.5MB | no              | top-level wrapper + `darwin-arm64`        |
| Mar `2026.3.31`    |            438 |       584.1MB |          234.8MB |                            0MB | no              | top-level wrapper + `darwin-arm64`        |
| Apr `2026.4.29`    |            392 |       335.0MB |           97.4MB |                            0MB | no              | none installed                            |
| `2026.5.22`        |            401 |     1,020.6MB |        1,020.4MB |                        911.8MB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| May `2026.5.26`    |            371 |       767.5MB |          767.4MB |                        656.4MB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| Latest `2026.5.27` |            371 |       786.9MB |          786.7MB |                        675.9MB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| Current `main`     |            314 |       407.4MB |          101.0MB |                            0MB | yes             | top-level wrapper + `darwin-arm64`        |

### Shrinkwrap boundary

<CardGroup cols={2}>
  <Card title="Before shrinkwrap" icon="unlock">
    `2026.5.20` has no root shrinkwrap and no large nested OpenClaw dependency
    tree.
  </Card>
  <Card title="Introduced" icon="lock">
    `2026.5.22` adds root shrinkwrap and installs 911.8MB under nested
    `openclaw/node_modules`.
  </Card>
  <Card title="Latest stable" icon="tag">
    `2026.5.27` keeps shrinkwrap and still installs 675.9MB under nested
    `openclaw/node_modules`.
  </Card>
  <Card title="Current main" icon="check">
    `main` keeps shrinkwrap and removes the nested OpenClaw dependency tree.
  </Card>
</CardGroup>

Published tarball inspection verifies the boundary:

| Version     | Published stable? | Root `npm-shrinkwrap.json` | Notes                                 |
| ----------- | ----------------- | -------------------------- | ------------------------------------- |
| `2026.5.20` | yes               | no                         | last stable release before shrinkwrap |
| `2026.5.21` | no                | n/a                        | no stable npm release                 |
| `2026.5.22` | yes               | yes                        | shrinkwrap introduced                 |
| `2026.5.23` | no                | n/a                        | no stable npm release                 |
| `2026.5.24` | no                | n/a                        | no stable npm release                 |
| `2026.5.25` | no                | n/a                        | no stable npm release                 |
| `2026.5.26` | yes               | yes                        | nested dependency tree still present  |
| `2026.5.27` | yes               | yes                        | nested dependency tree still present  |
| `main`      | n/a               | yes                        | nested dependency tree removed        |

The important distinction: **shrinkwrap itself is not the problem**. Current
`main` still ships root shrinkwrap. The problem was the package shape that made
npm materialize a large nested OpenClaw dependency tree and all 12
`@napi-rs/canvas` platform packages.

For a plain-English explanation of shrinkwrap and the maintainer-level package
checks, see [npm shrinkwrap](/gateway/security/shrinkwrap).

## Supply-chain interpretation

Dependency count is an operational security metric, not only an install-size
metric. Every package expands the set of maintainers, tarballs, transitive
updates, optional native binaries, and install-time behaviors that operators
must trust.

The cleanup direction is:

- keep heavy and optional capabilities outside the default core install
- make plugin packages own their runtime dependency graph
- avoid runtime package-manager repair during Gateway startup
- preserve deterministic installs without causing all-platform native package
  materialization
- keep install scripts disabled in package acceptance and measurement paths
- catch nested dependency trees and native optional dependency explosions before
  publishing

Related docs:

- [Plugin dependency resolution](/plugins/dependency-resolution)
- [Plugin inventory](/plugins/plugin-inventory)
- [Full release validation](/reference/full-release-validation)

## Unavailable performance runs

| Release             | Run                                                                          | Result    | Reason                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `v2026.5.3-1`       | [26561664645](https://github.com/openclaw/openclaw/actions/runs/26561664645) | failure   | mock-provider job failed: CLI startup timed out waiting for qa-channel ready; no qa-channel accounts reported |
| `v2026.5.3`         | [26561666722](https://github.com/openclaw/openclaw/actions/runs/26561666722) | failure   | mock-provider job failed: CLI startup timed out waiting for qa-channel ready; no qa-channel accounts reported |
| `v2026.4.29-beta.2` | [26561683635](https://github.com/openclaw/openclaw/actions/runs/26561683635) | cancelled | optional baseline fetch hung before artifact upload                                                           |

## Follow-up gates

Recommended release checks from this sweep:

1. Run the mock-provider performance smoke for release candidates and retain
   artifacts.
2. Track cold turn, warm turn, agent RSS, Gateway `readyz`, and CLI health.
3. Fresh-install the packed tarball with scripts disabled.
4. Record installed dependency count, install size, package size, nested
   `openclaw/node_modules` size, and native optional package shape.
5. Fail or hold release review when nested dependency trees or all-platform
   native packages appear unexpectedly.
