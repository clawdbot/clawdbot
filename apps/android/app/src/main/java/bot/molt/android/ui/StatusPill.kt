package bot.molt.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun StatusPill(
  gateway: GatewayState,
  voiceEnabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  activity: StatusActivity? = null,
) {
  Surface(
    onClick = onClick,
    modifier = modifier,
    shape = RoundedCornerShape(14.dp),
    color = overlayContainerColor(),
    tonalElevation = 3.dp,
    shadowElevation = 0.dp,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Surface(
          modifier = Modifier.size(9.dp),
          shape = CircleShape,
          color = gateway.color,
        ) {}

        Text(
          text = gateway.title,
          style = MaterialTheme.typography.labelLarge,
        )
      }

      VerticalDivider(
        modifier = Modifier.height(14.dp).alpha(0.35f),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )

      if (activity != null) {
        Row(
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(
            imageVector = activity.icon,
            contentDescription = activity.contentDescription,
            tint = activity.tint ?: overlayIconColor(),
            modifier = Modifier.size(18.dp),
          )
          Text(
            text = activity.title,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
          )
        }
      } else {
        Icon(
          imageVector = if (voiceEnabled) Icons.Default.Mic else Icons.Default.MicOff,
          contentDescription = if (voiceEnabled) "Voice enabled" else "Voice disabled",
          tint =
            if (voiceEnabled) {
              overlayIconColor()
            } else {
              MaterialTheme.colorScheme.onSurfaceVariant
            },
          modifier = Modifier.size(18.dp),
        )
      }

      Spacer(modifier = Modifier.width(2.dp))
    }
  }
}

data class StatusActivity(
  val title: String,
  val icon: androidx.compose.ui.graphics.vector.ImageVector,
  val contentDescription: String,
  val tint: Color? = null,
)

enum class GatewayState(val title: String, val color: Color) {
  Connected("Connected", Color(0xFF2ECC71)),
  Connecting("Connecting…", Color(0xFFF1C40F)),
  Error("Error", Color(0xFFE74C3C)),
  Disconnected("Offline", Color(0xFF9E9E9E)),
}
