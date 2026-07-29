## Assets & Operating Meters (2026-07-29)

PropertyManager now tracks operating meters for ranch equipment and vehicles.

- **Architecture doc:** OpenClaw repo `docs/architecture/PROPERTYMANAGER_ASSETS_AND_METERS.md`
- **Postgres migration:** `005_assets_and_meters.sql` (schema version 005)
- **API:** `/assets`, `/assets/<id>/meter-readings`, `/meter-readings/parse`
- **Dashboard QR:** `/pm/asset/<qr_token>` on OpenClaw dashboard
- **Mac:** Sidebar → **Show Assets** for meter entry and PM remaining
- **iPhone/iPad:** **Assets** tab with Update Hours/Miles/Cycles and voice entry

### Sync model (updated)

Mac and iPhone use **automatic API sync** (no manual Publish/Refresh as primary workflow). Sidebar **Refresh** reloads tasks and assets on demand.

CSV remains export-only for legacy briefing/Telegram paths until they read Postgres directly.
