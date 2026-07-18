package ai.openclaw.wear

import android.content.ComponentName
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textButton
import androidx.wear.protolayout.modifiers.clickable
import androidx.wear.protolayout.types.layoutString
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders

class OpenClawTileService : Material3TileService() {
  override suspend fun MaterialScope.tileResponse(requestParams: RequestBuilders.TileRequest): TileBuilders.Tile {
    val openAction = ActionBuilders.launchAction(ComponentName(this@OpenClawTileService, MainActivity::class.java))
    val openClickable = clickable(action = openAction, id = "open_openclaw")
    val layout =
      primaryLayout(
        titleSlot = { text(getString(R.string.app_name).uppercase().layoutString) },
        mainSlot = { text(getString(R.string.tile_phone_proxy).layoutString) },
        bottomSlot = {
          textButton(
            onClick = openClickable,
            labelContent = { text(getString(R.string.tile_open).layoutString) },
          )
        },
        onClick = openClickable,
      )
    return TileBuilders.Tile
      .Builder()
      .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout))
      .build()
  }
}
