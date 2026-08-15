# @openclaw/diagnostics-prometheus

Official Prometheus diagnostics exporter for OpenClaw.

This plugin exposes OpenClaw Gateway runtime metrics in Prometheus text format for Prometheus, Grafana, VictoriaMetrics, and compatible scrapers.

## Install

```bash
openclaw plugins install @openclaw/diagnostics-prometheus
```

Restart the Gateway after installing or updating the plugin.

## Configure

Enable the plugin and set the scrape endpoint options in `plugins.entries.diagnostics-prometheus.config`.

The full config surface, metric names, and scrape examples live in the docs:

- https://docs.openclaw.ai/gateway/prometheus

## Package

- Plugin id: `diagnostics-prometheus`
- Package: `@openclaw/diagnostics-prometheus`
- Minimum OpenClaw host: `2026.4.25`
