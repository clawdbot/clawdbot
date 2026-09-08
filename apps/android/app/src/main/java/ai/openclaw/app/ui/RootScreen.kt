package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier

/** Chooses onboarding or the authenticated app shell from persisted app state. */
@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()
  val features = rememberWindowDisplayFeatures()

  if (!onboardingCompleted) {
    FoldAwareContent(
      features = features,
      modifier = Modifier.background(MaterialTheme.colorScheme.background),
    ) {
      OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    }
  } else {
    ShellScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize(), features = features)
  }
}
