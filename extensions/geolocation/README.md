# Geolocation plugin

Resolves a client IP address to a coarse city, so surfaces that already show a
connecting address can show a place instead of only a number.

## How it works

The plugin exposes one authenticated route:

```
GET /plugins/geolocation/lookup?ip=<address>
```

It answers `{ found, city?, region?, country?, countryCode?, attribution }`. A
database that is missing or still downloading returns `503`, never
`found: false` — "we cannot answer" and "this address has no place" are
different answers and callers must be able to tell them apart.

The database is downloaded on first lookup into
`<state-dir>/geolocation/`, kept until it ages past `refreshDays`, and reused
from disk after that. A failed refresh serves the cached copy rather than taking
lookups down. A body that does not parse as an MMDB is discarded without
replacing a working database.

## Data source and license

The default source is **DB-IP City Lite**, licensed **CC BY 4.0**. That license
requires attribution, so every answer carries the credit and the Control UI
renders it next to the value. The database is downloaded at runtime and never
redistributed by OpenClaw.

All plugin code is MIT, as is the `maxmind` reader it uses. No free city-level
IP database is MIT-licensed; the obligation lives with the data, not the code.

To use a different source, set `databaseUrl` and set `attributionText` /
`attributionUrl` to whatever that source requires. `{yyyy}` and `{mm}` expand to
a release month, and the previous month is tried when the current build is not
published yet.

## Accuracy

City-level IP geolocation is right roughly 55-80% of the time and is worst
exactly where it matters most: mobile carriers, VPNs, and corporate egress all
resolve to the operator's exit point rather than the person. Treat the answer as
a hint. The client-reported time zone shown beside it is often the better
signal, because it survives proxies and CGNAT ranges where the address does not.
