package ai.openclaw.app.ui.design

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Preview(
  name = "OpenClaw Design System",
  showBackground = true,
  backgroundColor = 0xFF030303,
)
@Composable
private fun ClawComponentShowcasePreview() {
  ClawDesignTheme {
    ClawComponentShowcase()
  }
}
