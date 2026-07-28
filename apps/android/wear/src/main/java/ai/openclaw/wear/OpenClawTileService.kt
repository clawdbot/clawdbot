package ai.openclaw.wear

import android.content.ComponentName
import android.content.Context
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.layout.androidImageResource
import androidx.wear.protolayout.layout.imageResource
import androidx.wear.protolayout.material3.ButtonDefaults.filledTonalButtonColors
import androidx.wear.protolayout.material3.ColorScheme
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.avatarButton
import androidx.wear.protolayout.material3.avatarImage
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textEdgeButton
import androidx.wear.protolayout.modifiers.LayoutModifier
import androidx.wear.protolayout.modifiers.clickable
import androidx.wear.protolayout.modifiers.contentDescription
import androidx.wear.protolayout.types.argb
import androidx.wear.protolayout.types.layoutString
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders

class OpenClawTileService :
  Material3TileService(
    allowDynamicTheme = false,
    defaultColorScheme = openClawTileColorScheme,
  ) {
  override suspend fun MaterialScope.tileResponse(requestParams: RequestBuilders.TileRequest): TileBuilders.Tile {
    val talkAction = wearLaunchAction(this@OpenClawTileService, WearLaunchTarget.Voice)
    val openAction = wearLaunchAction(this@OpenClawTileService, WearLaunchTarget.Chat)
    val talkClickable = clickable(action = talkAction, id = "talk_openclaw")
    val openClickable = clickable(action = openAction, id = "open_openclaw")
    val layout =
      primaryLayout(
        titleSlot = { text(getString(R.string.app_name).layoutString) },
        mainSlot = {
          avatarButton(
            onClick = talkClickable,
            modifier = LayoutModifier.contentDescription(getString(R.string.talk)),
            avatarContent = {
              avatarImage(
                resource =
                  imageResource(
                    androidImage = androidImageResource(R.mipmap.ic_launcher_foreground),
                  ),
                protoLayoutResourceId = "openclaw_core_mascot",
              )
            },
            labelContent = { text(getString(R.string.talk).uppercase().layoutString) },
            secondaryLabelContent = { text(getString(R.string.tile_phone_proxy).layoutString) },
          )
        },
        bottomSlot = {
          textEdgeButton(
            onClick = openClickable,
            modifier = LayoutModifier.contentDescription(getString(R.string.tile_open)),
            colors = filledTonalButtonColors(),
            labelContent = { text(getString(R.string.tile_open).layoutString) },
          )
        },
      )
    return TileBuilders.Tile
      .Builder()
      .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout))
      .build()
  }
}

private val openClawTileColorScheme =
  ColorScheme(
    primary = 0xFFFFFFFF.argb,
    primaryDim = 0xFFA8A8A8.argb,
    primaryContainer = 0xFFFFFFFF.argb,
    onPrimary = 0xFF050505.argb,
    onPrimaryContainer = 0xFF050505.argb,
    surfaceContainerLow = 0xFF0A0A0A.argb,
    surfaceContainer = 0xFF111111.argb,
    surfaceContainerHigh = 0xFF1A1A1A.argb,
    onSurface = 0xFFF8F8F8.argb,
    onSurfaceVariant = 0xFFA8A8A8.argb,
    outline = 0xFF3A3A3A.argb,
    outlineVariant = 0xFF242424.argb,
    background = 0xFF030303.argb,
    onBackground = 0xFFF8F8F8.argb,
  )

internal fun wearLaunchAction(
  context: Context,
  target: WearLaunchTarget,
): ActionBuilders.LaunchAction =
  ActionBuilders.launchAction(
    ComponentName(context, MainActivity::class.java),
    mapOf(extraWearLaunchTarget to ActionBuilders.stringExtra(target.rawValue)),
  )
