#!/usr/bin/env bash
set -euo pipefail

source ~/.openclaw/credentials/homeassistant.env

curl -s \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "$HA_URL/api/states" \
| jq -r '
  .[]
  | select(
      .entity_id == "sensor.jacuzzi_power" or
      .entity_id == "sensor.well_pump_power" or
      .entity_id == "sensor.garage_freezer_power" or
      .entity_id == "binary_sensor.jacuzzi_power" or
      .entity_id == "binary_sensor.well_pump_power" or
      .entity_id == "binary_sensor.garage_freezer_power" or
      (.entity_id | startswith("media_player."))
    )
  | "\(.entity_id) = \(.state) | \(.attributes.friendly_name // "")"
'
