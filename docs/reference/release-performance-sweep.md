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

- **Release performance sweep:** GitHub Releases from `v2026.5.28` back through
  stable `v2026.4.23`, using the `OpenClaw Performance` workflow,
  `profile=smoke`, mock-provider lane. Most tag rows are one sample; the
  `v2026.5.27` and `v2026.5.28` rows use the latest repeat-3 release-branch
  artifacts.
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
The main performance sweep uses one smoke sample per tag, except the
`v2026.5.27` and `v2026.5.28` rows, which use the latest repeat-3
release-branch artifacts. Earlier April context uses published repeat-3
medians from `clawgrit-reports`. Treat the numbers as trend evidence and
regression-hunting signal, not as release-gate statistics.
</Warning>

## Snapshot

Performance coverage: **77 requested releases**, **74 artifact-backed points**,
and **3 unavailable CI runs**. Latest stable measured point: `v2026.5.28`.

<CardGroup cols={2}>
  <Card title="Stable agent turn" icon="gauge">
    **5.1x faster cold turn**

    - `v2026.4.14`: 9.8s
    - `v2026.5.28`: 1.9s

  </Card>
  <Card title="Published package" icon="package">
    **17.9MB tarball**

    Latest stable package, down from the 43.3MB March package-size peak.

  </Card>
  <Card title="Latest stable install" icon="hard-drive">
    **361.7MiB fresh install**

    `v2026.5.28` cuts the nested OpenClaw dependency tree sharply, but a
    smaller 259.7MiB nested tree still remains in the local install audit.

  </Card>
  <Card title="Dependency graph" icon="boxes">
    **300 installed packages**

    Latest stable release, measured as unique package name/version roots in a
    fresh install with scripts disabled.

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
    **361.7MiB install**

    `2026.5.28` cuts fresh install size by 52.8% from `2026.5.27`, but still
    installs a 259.7MiB nested OpenClaw tree.

  </Card>
  <Card title="Dependency graph" icon="scissors">
    **300 package roots**

    `2026.5.28` installs 71 fewer unique package name/version roots than
    `2026.5.27`.

  </Card>
</CardGroup>

<Tip>
Shrinkwrap was not the problem by itself. The bad package shape was.
`v2026.5.28` still ships shrinkwrap, but the nested dependency tree is much
smaller and the all-platform canvas fanout is gone in the local audit.
</Tip>

## What Changed In 5.28

The cleanup between `v2026.5.27` and `v2026.5.28` reduced the default-install
graph instead of removing the capabilities themselves.

<CardGroup cols={2}>
  <Card title="Root default graph" icon="git-branch">
    Unique package name/version roots fell from **371** to **300**. Package
    instances fell from **372** to **301**.
  </Card>
  <Card title="Nested tree" icon="unplug">
    Nested `openclaw/node_modules` fell from **656.1MiB** to **259.7MiB** in
    the same local install audit.
  </Card>
  <Card title="Native optional cones" icon="cpu">
    The all-platform `@napi-rs/canvas` native package cone stopped landing in
    the default install.
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

| Metric          | Earlier April baseline | `v2026.5.28` |                    Delta |
| --------------- | ---------------------: | -----------: | -----------------------: |
| Cold agent turn |                9,819ms |      1,908ms | 80.6% lower, 5.1x faster |
| Warm agent turn |                7,458ms |      1,870ms | 74.9% lower, 4.0x faster |
| Agent peak RSS  |                686.2MB |      581.0MB |              15.3% lower |

The earlier April baseline is `v2026.4.14` from the published
`clawgrit-reports` mock-provider run. That run used repeat 3 and failed only
because the diagnostic timeline was not emitted; the cold, warm, and RSS
medians are still useful as rough scale. Treat this as narrative context, not a
release-gate statistic.

Within the May sweep, the latest release-branch row moved materially from
`v2026.5.2`:

| Metric          | `v2026.5.2` | `v2026.5.28` |       Delta |
| --------------- | ----------: | -----------: | ----------: |
| Cold agent turn |     3,897ms |      1,908ms | 51.0% lower |
| Warm agent turn |     3,610ms |      1,870ms | 48.2% lower |
| Agent peak RSS  |     613.7MB |      581.0MB |  5.3% lower |

Compared with the previous stable release:

| Metric          | `v2026.5.27` | `v2026.5.28` |       Delta |
| --------------- | -----------: | -----------: | ----------: |
| Cold agent turn |      2,231ms |      1,908ms | 14.5% lower |
| Warm agent turn |      2,226ms |      1,870ms | 16.0% lower |
| Agent peak RSS  |      649.0MB |      581.0MB | 10.5% lower |

### Install footprint

| Metric                                          |  Baseline | `v2026.5.28` |       Delta |
| ----------------------------------------------- | --------: | -----------: | ----------: |
| Install size from `2026.5.22` peak              | 1,020.6MB |     361.7MiB | 64.6% lower |
| Install size from latest release `2026.5.27`    |  767.1MiB |     361.7MiB | 52.8% lower |
| Dependencies from monthly high `2026.2.26`      |       645 |          300 | 53.5% lower |
| Dependencies from latest release `2026.5.27`    |       371 |          300 | 19.1% lower |
| Nested `openclaw/node_modules` from `2026.5.22` |   911.8MB |     259.7MiB | 71.5% lower |
| Nested `openclaw/node_modules` from `2026.5.27` |  656.1MiB |     259.7MiB | 60.4% lower |

### npm package size

| Version     | Compressed tarball | Unpacked package |  Files | Notes                             |
| ----------- | -----------------: | ---------------: | -----: | --------------------------------- |
| `2026.1.30` |             12.8MB |           33.5MB |  4,607 | early rebranded package           |
| `2026.2.26` |             23.6MB |           82.9MB | 10,125 | feature growth                    |
| `2026.3.31` |             43.3MB |          182.6MB | 21,037 | package-size high point           |
| `2026.4.29` |             22.9MB |           74.6MB |  9,309 | package pruning visible           |
| `2026.5.12` |             23.4MB |           80.1MB | 12,035 | major external-plugin split       |
| `2026.5.22` |             17.2MB |           76.9MB | 12,386 | docs/assets excluded from package |
| `2026.5.27` |             17.8MB |           79.0MB | 12,509 | previous stable package           |
| `2026.5.28` |             17.9MB |           81.0MB |  9,082 | latest stable package             |

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

Supplied sweep:

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
| `v2026.5.27`        | PASS |   2,231ms |   2,226ms |        649.0MB |
| `v2026.5.28`        | PASS |   1,908ms |   1,870ms |        581.0MB |

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
| `v2026.5.27`        |              1,491ms |                 1,571ms |          553ms |        401.5MB |
| `v2026.5.28`        |              1,457ms |                 1,474ms |          623ms |        386.1MB |

The `v2026.5.22` CLI health spike is visible in this table even though the
agent-turn lane still passed. Keep the source probes when investigating
targeted CLI or gateway regressions.

## Install footprint audit

Dependency samples use one stable release per month, plus the
`2026.5.22` shrinkwrap-introduction event and the latest `2026.5.28` release.

| Point              | Installed deps | Fresh install | OpenClaw package | Nested `openclaw/node_modules` | Root shrinkwrap | Canvas install behavior                   |
| ------------------ | -------------: | ------------: | ---------------: | -----------------------------: | --------------- | ----------------------------------------- |
| Jan `2026.1.30`    |            605 |       438.4MB |           45.8MB |                          2.4MB | no              | top-level wrapper + `darwin-arm64`        |
| Feb `2026.2.26`    |            645 |       575.7MB |          110.1MB |                          3.5MB | no              | top-level wrapper + `darwin-arm64`        |
| Mar `2026.3.31`    |            438 |       584.1MB |          234.8MB |                            0MB | no              | top-level wrapper + `darwin-arm64`        |
| Apr `2026.4.29`    |            392 |       335.0MB |           97.4MB |                            0MB | no              | none installed                            |
| `2026.5.22`        |            401 |     1,020.6MB |        1,020.4MB |                        911.8MB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| May `2026.5.26`    |            371 |       767.5MB |          767.4MB |                        656.4MB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| `2026.5.27`        |            371 |      767.1MiB |         766.9MiB |                       656.1MiB | yes             | nested: all 12 `@napi-rs/canvas` packages |
| Latest `2026.5.28` |            300 |      361.7MiB |         361.6MiB |                       259.7MiB | yes             | none installed                            |

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
    `2026.5.28` keeps shrinkwrap and still installs 259.7MiB under nested
    `openclaw/node_modules`.
  </Card>
  <Card title="Canvas fanout fixed" icon="check">
    `2026.5.28` no longer installs any `@napi-rs/canvas` packages in the local
    fresh install audit.
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
| `2026.5.28` | yes               | yes                        | nested dependency tree much smaller   |

The important distinction: **shrinkwrap itself is not the problem**.
`v2026.5.28` still ships root shrinkwrap. The problem was the package shape
that made npm materialize a large nested OpenClaw dependency tree and all 12
`@napi-rs/canvas` platform packages. The nested tree is smaller in `v2026.5.28`,
and the canvas platform fanout no longer lands in the local audit.

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
