---
summary: "Adds syntax highlighting for languages outside the default diffs viewer set."
read_when:
  - You are installing, configuring, or auditing the diffs-language-pack plugin
title: "Diffs Language Pack plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Adds syntax highlighting for languages outside the default diffs viewer set.

## Distribution

- Package: `@openclaw/diffs-language-pack`
- Install route: npm or ClawHub: `clawhub:@openclaw/diffs-language-pack`

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

## Added languages

The base `diffs` plugin already highlights the common languages documented in [Diffs](/tools/diffs). Install this language pack when you want syntax highlighting for a broader set of Shiki-supported languages. If the pack is not installed, those files still render as readable plain text.

Examples include Astro, Vue, Svelte, MDX, GraphQL, Terraform/HCL, Nix, Clojure, Elixir, Haskell, OCaml, Scala, Zig, Solidity, Verilog/VHDL, Fortran, MATLAB, LaTeX, Mermaid, Sass/Less/SCSS, Nginx, Apache, CSV, dotenv, INI, and diff files.

See [Shiki languages](https://shiki.style/languages) for Shiki's upstream language and alias catalog.

<!-- openclaw-plugin-reference:manual-end -->
