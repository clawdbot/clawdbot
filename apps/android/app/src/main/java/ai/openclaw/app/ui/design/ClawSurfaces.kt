package ai.openclaw.app.ui.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Standard inset panel for grouped Android app content.
 *
 * Structure comes from a hairline border on a flat surface, not from shadow. Nested
 * panels would otherwise stack elevation and turn a dense screen into a card pile.
 */
@Composable
internal fun ClawPanel(
  modifier: Modifier = Modifier,
  contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
  content: @Composable () -> Unit,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(contentPadding)) {
      content()
    }
  }
}

/**
 * Shared empty state used when a screen has no records but can still offer an action.
 */
@Composable
internal fun ClawEmptyState(
  title: String,
  body: String,
  modifier: Modifier = Modifier,
  action: (@Composable () -> Unit)? = null,
) {
  ClawPanel(modifier = modifier) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = body, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      action?.invoke()
    }
  }
}

/**
 * Shared loading placeholder that keeps async screen states visually consistent.
 */
@Composable
internal fun ClawLoadingState(
  title: String,
  modifier: Modifier = Modifier,
) {
  ClawPanel(modifier = modifier) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      CircularProgressIndicator(color = ClawTheme.colors.primary, strokeWidth = 2.dp)
      Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}
