package ai.openclaw.app

import ai.openclaw.app.ui.OpenClawTheme
import ai.openclaw.app.ui.RootScreen
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main Android activity that owns Compose UI attachment and runtime UI wiring.
 */
class MainActivity : ComponentActivity() {
  private val viewModel: MainViewModel by viewModels()
  private lateinit var permissionRequester: PermissionRequester
  private var initializedViewModel: MainViewModel? = null
  private var didAttachRuntimeUi = false
  private var didStartNodeService = false
  private var didStartViewModelCollectors = false
  private var foreground = false
  private var pendingIntent: Intent? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    pendingIntent = intent
    WindowCompat.setDecorFitsSystemWindows(window, false)
    permissionRequester = PermissionRequester(this)

    setContent {
      var activeViewModel by remember { mutableStateOf<MainViewModel?>(null) }

      LaunchedEffect(Unit) {
        withFrameNanos { }
        withContext(Dispatchers.Default) {
          (application as NodeApp).prefs
        }
        val readyViewModel = viewModel
        activateViewModel(readyViewModel)
        activeViewModel = readyViewModel
      }

      OpenClawTheme {
        activeViewModel?.let { RootScreen(viewModel = it) } ?: StartupSurface()
      }
    }
  }

  override fun onStart() {
    super.onStart()
    foreground = true
    initializedViewModel?.setForeground(true)
  }

  override fun onStop() {
    foreground = false
    initializedViewModel?.setForeground(false)
    super.onStop()
  }

  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    pendingIntent = intent
    initializedViewModel?.let { handleAssistantIntent(viewModel = it, intent = intent) }
  }

  /**
   * Wires MainViewModel only after Activity first draw and background prefs warm-up.
   */
  private fun activateViewModel(readyViewModel: MainViewModel) {
    if (initializedViewModel != null) return
    initializedViewModel = readyViewModel
    readyViewModel.setForeground(foreground)
    startViewModelCollectors(readyViewModel)
    pendingIntent?.let { initialIntent ->
      handleAssistantIntent(viewModel = readyViewModel, intent = initialIntent)
      pendingIntent = null
    }
  }

  /**
   * Starts lifecycle collectors after ViewModel construction so they cannot force early startup.
   */
  private fun startViewModelCollectors(readyViewModel: MainViewModel) {
    if (didStartViewModelCollectors) return
    didStartViewModelCollectors = true

    lifecycleScope.launch {
      repeatOnLifecycle(Lifecycle.State.STARTED) {
        readyViewModel.preventSleep.collect { enabled ->
          if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          }
        }
      }
    }

    lifecycleScope.launch {
      repeatOnLifecycle(Lifecycle.State.STARTED) {
        readyViewModel.runtimeInitialized.collect { ready ->
          if (!ready || didAttachRuntimeUi) return@collect
          // Runtime UI helpers need an Activity owner, so attach once after NodeRuntime is ready.
          readyViewModel.attachRuntimeUi(owner = this@MainActivity, permissionRequester = permissionRequester)
          didAttachRuntimeUi = true
          if (!didStartNodeService) {
            NodeForegroundService.start(this@MainActivity)
            didStartNodeService = true
          }
        }
      }
    }
  }

  /**
   * Routes assistant/app-action intents into ViewModel state without recreating the activity.
   */
  private fun handleAssistantIntent(
    viewModel: MainViewModel,
    intent: Intent?,
  ) {
    parseHomeDestinationIntent(intent)?.let { destination ->
      viewModel.requestHomeDestination(destination)
      return
    }
    val request = parseAssistantLaunchIntent(intent) ?: return
    viewModel.handleAssistantLaunch(request)
  }
}

@Composable
private fun StartupSurface() {
  Surface(
    modifier = Modifier.fillMaxSize(),
    color = Color.Black,
    contentColor = Color.White,
  ) {
    Box(
      modifier = Modifier.fillMaxSize(),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = "OPENCLAW",
        fontSize = 22.sp,
        fontWeight = FontWeight.Medium,
      )
    }
  }
}
