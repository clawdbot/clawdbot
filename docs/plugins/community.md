---
summary: "Find and publish community-maintained OpenClaw plugins"
read_when:
  - You want to find third-party OpenClaw plugins
  - You want to publish or list your own plugin on ClawHub
title: "Community plugins"
doc-schema-version: 1
---

Community plugins are third-party packages that extend OpenClaw with channels,
tools, providers, hooks, or other capabilities. Use [ClawHub](/clawhub) as the
primary discovery surface for public community plugins.

## Find plugins

Search ClawHub from the CLI:

```bash
openclaw plugins search "calendar"
```

Install a ClawHub plugin with an explicit source prefix:

```bash
openclaw plugins install clawhub:<package-name>
```

npm remains a supported direct-install path during the launch cutover:

```bash
openclaw plugins install npm:<package-name>
```

Use [Manage plugins](/plugins/manage-plugins) for common install, update,
inspect, and uninstall examples. Use [`openclaw plugins`](/cli/plugins) for the
full command reference and source-selection rules.

## Publish plugins

Publish public community plugins on ClawHub when you want OpenClaw users to
discover and install them. ClawHub owns the live package listing, release
history, scan status, and install hints; the docs do not maintain a static
third-party plugin catalog.

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

Before publishing, make sure the plugin has package metadata, a plugin manifest,
setup docs, and a clear maintenance owner. ClawHub validates owner scope,
package name, version, file limits, and source metadata before it creates a
release, then keeps new releases hidden from normal install and download
surfaces until review and verification finish.

Use this checklist before you publish:

| Requirement          | Why                                                 |
| -------------------- | --------------------------------------------------- |
| Published on ClawHub | Users need `openclaw plugins install` hints to work |
| Public GitHub repo   | Source review, issue tracking, transparency         |
| Setup and usage docs | Users need to know how to configure it              |
| Active maintenance   | Recent updates or responsive issue handling         |

Use these pages for the full publishing contract:

- [ClawHub publishing](/clawhub/publishing) explains owners, scopes, releases,
  review, package validation, and package transfer.
- [Building plugins](/plugins/building-plugins) shows the plugin package shape
  and first publish workflow.
- [Plugin manifest](/plugins/manifest) defines native plugin manifest fields.

## Related

- [Plugins](/tools/plugin) - install, configure, restart, and troubleshoot
- [Manage plugins](/plugins/manage-plugins) - command examples
- [ClawHub publishing](/clawhub/publishing) - publish and release rules
