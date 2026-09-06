---
summary: "Resolve a connecting client's IP address to a coarse city using a locally cached database, with no per-lookup third-party calls"
read_when:
  - You want to see where the people using your Gateway are connecting from
  - You are choosing or replacing the IP-geolocation database and need its license terms
  - A location is missing, wrong, or stuck and you need to know which layer failed
title: "Geolocation plugin"
---

The bundled `geolocation` plugin turns a connecting client's IP address into a coarse city. It ships with OpenClaw, downloads its database on first use, and answers entirely from that local copy, so a lookup never sends an address to a third party.

It owns exactly one thing: address to place. It does not decide which addresses get looked up, does not store results, and is not an authorization input. The Control UI uses it to label the devices on a person's [Activity](/concepts/presence) card; anything else that needs a place can call the same route.

## Quickstart

The plugin is bundled and active by default. To see it work, open **Activity**, pick a person, and look at their device row. A remote client shows its address and the resolved city:

```
openclaw-control-ui  MacIntel · 8.8.8.8 · Europe/Vienna  Mountain View, California ⓘ
```

The first view after a fresh install shows no city while the database downloads; the row fills itself in once it is ready, without a reload. To check the plugin directly:

```bash
curl -s "http://127.0.0.1:18789/plugins/geolocation/lookup?ip=8.8.8.8" -H "Authorization: Bearer <GATEWAY_TOKEN>"
```

```json
{
  "found": true,
  "city": "Mountain View",
  "region": "California",
  "country": "United States",
  "countryCode": "US",
  "attribution": { "text": "IP Geolocation by DB-IP", "url": "https://db-ip.com" }
}
```

Use an address that is actually routable. Reserved ranges such as `203.0.113.0/24`
are absent from the database and answer `{"found": false}`:

```json
{
  "found": false,
  "attribution": { "text": "IP Geolocation by DB-IP", "url": "https://db-ip.com" }
}
```

The first call also downloads the database, so expect it to take up to a minute
while later calls answer from the local copy.

## Why some clients never show a location

A location only appears when the Gateway recorded a usable public address for that client, and often it did not:

- Connect handling omits `ip` entirely for loopback clients, so anything reaching the Gateway over an SSH tunnel or local port forward has no address to resolve.
- Tailscale clients arrive on a `100.64/10` carrier-grade-NAT address and LAN clients on a private one. Both are recorded and displayed, but no geolocation database contains them, so the plugin answers `found: false` for these ranges without loading the database at all. A tailnet-only or LAN-only Gateway therefore never downloads one.
- Mobile carriers, VPNs, and corporate egress resolve to the operator's exit point, not the person. The answer is confidently wrong rather than missing.

This is why the device row also carries the client-reported time zone. A browser knows its own zone regardless of how it reached the Gateway, so `Europe/Vienna` keeps working exactly where the address stops being informative. Treat the city as a hint and the zone as the more reliable signal. See [Presence](/concepts/presence) for how both fields are produced.

## Configuration

Every option is optional. The defaults are a working setup.

| Option            | Default                       | Purpose                                                              |
| ----------------- | ----------------------------- | -------------------------------------------------------------------- |
| `databaseUrl`     | monthly DB-IP City Lite build | MMDB source. `{yyyy}` and `{mm}` expand to a release month.          |
| `attributionText` | `IP Geolocation by DB-IP`     | Credit shown next to every result.                                   |
| `attributionUrl`  | `https://db-ip.com`           | Link target for the credit.                                          |
| `refreshDays`     | `30`                          | How stale the cached database may get before it is downloaded again. |

```json5
{
  plugins: {
    entries: {
      geolocation: {
        config: {
          refreshDays: 7,
        },
      },
    },
  },
}
```

Monthly builds appear a few days into the month, so the plugin tries the current month and falls back to the previous one. A source that needs no month substitution is fetched as written.

### Using a different database

Set `databaseUrl` together with both attribution fields. The credit belongs to whichever dataset you point at, so changing the source without changing the credit misattributes the data:

```json5
{
  plugins: {
    entries: {
      geolocation: {
        config: {
          databaseUrl: "https://example.internal/geoip/city.mmdb",
          attributionText: "IP data by Example",
          attributionUrl: "https://example.internal",
        },
      },
    },
  },
}
```

Any MaxMind-format city database works, including a self-hosted mirror or a commercial build you already license. The cache file is named after the source URL, so switching sources cannot serve the previous provider's data under the new provider's credit.

## Data license

The default database is **DB-IP City Lite**, licensed **CC BY 4.0**. That license requires attribution, which is why the credit is part of every response and is rendered next to the value rather than buried in settings.

OpenClaw downloads this database at runtime and never redistributes it, so the license attaches to your deployment's use of the data, not to OpenClaw itself. Plugin code and the `maxmind` reader it uses are MIT. No free city-level IP database is MIT-licensed; the obligation lives with the data.

Expect city-level accuracy in the 55-80% range, and worse for the mobile, VPN, and CGNAT cases above.

## How the database is managed

The download is lazy and demand-driven. It happens on the first lookup of a **public** address, which in practice requires all of the following: an authenticated identity exists, an operator opened that person's Activity view, and that client connected from a routable address. A Gateway nobody inspects — or one reached only over loopback, a tunnel, a LAN, or a tailnet — never downloads anything.

On that first qualifying lookup the plugin fetches the database into `<state-dir>/geolocation/`, parses it before publishing it, and keeps it until it ages past `refreshDays`.

Four behaviors are worth knowing because they decide what you see during a failure:

- The response is read against a compressed ceiling and inflated against an on-disk ceiling, both enforced while reading. A replaced source cannot allocate an unbounded body, and a compression bomb cannot inflate past the limit.
- A body that does not parse as an MMDB is discarded without replacing a working database. A rate-limit page or truncated download cannot break a Gateway that was working a minute ago.
- A failed refresh serves the cached copy and logs a warning. Stale data beats no data.
- Concurrent first lookups share one download rather than each starting their own.

## Troubleshooting

**No location on any device row.** Either the Gateway recorded no address — a row showing only a platform and time zone has no `ip`, which is expected for loopback and tunneled clients — or every address present is private or carrier-grade NAT, which the plugin answers without consulting the database. Nothing is broken in either case.

**Every lookup returns 503.** The database is unavailable — still downloading, or every candidate URL failed. Check the Gateway log for `geolocation: downloaded` or a `geolocation database download failed` line naming each URL it tried. A Gateway with no outbound network access cannot fetch the database; point `databaseUrl` at an internal mirror instead.

**A `found: false` answer.** The database has no entry for that address. This is a data limitation, not a failure. Note that 503 and `found: false` are deliberately different: one means the plugin could not answer, the other means the database has no place for that address.

**A wrong city.** Confirm the address is the person's, not a VPN or carrier exit. If it is genuinely wrong, DB-IP accepts corrections, or point `databaseUrl` at a commercial database with better coverage.

## Related

- [Presence](/concepts/presence) — how connect records the address and time zone this plugin reads
- [Manage plugins](/plugins/manage-plugins) — enabling, disabling, and configuring bundled plugins
- [Trusted proxy auth](/gateway/trusted-proxy-auth) — how the Gateway determines a client address behind a proxy
