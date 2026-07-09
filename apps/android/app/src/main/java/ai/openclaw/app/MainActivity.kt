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
import androidx.compose.runtime.collectAsState
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
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
  private var didStartViewModelCollectors = false
  private var foreground = false
  private val pendingIntentRouter = MainActivityPendingIntentRouter()
  private val runtimeUiStarter = MainActivityRuntimeUiStarter()
  private var screenshotScene: AndroidScreenshotScene? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    pendingIntentRouter.setInitialIntent(intent)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    permissionRequester = PermissionRequester(this)
    if (BuildConfig.DEBUG) {
      screenshotScene = parseAndroidScreenshotModeIntent(intent)
      if (screenshotScene != null) hideScreenshotModeStatusBar()
    }

    setContent {
      var activeViewModel by remember { mutableStateOf<MainViewModel?>(null) }

      LaunchedEffect(Unit) {
        withFrameNanos { }
        withContext(Dispatchers.Default) {
          (application as NodeApp).prefs
        }
        val readyViewModel = viewModel
        screenshotScene?.let(readyViewModel::enterScreenshotFixtureMode)
        activateViewModel(readyViewModel)
        activeViewModel = readyViewModel
      }

      val currentViewModel = activeViewModel
      if (currentViewModel == null) {
        OpenClawTheme {
          StartupSurface()
        }
      } else {
        val appearanceThemeMode by currentViewModel.appearanceThemeMode.collectAsState()
        OpenClawTheme(themeMode = appearanceThemeMode) {
          RootScreen(viewModel = currentViewModel)
        }
      }
    }
  }

  private fun hideScreenshotModeStatusBar() {
    WindowCompat
      .getInsetsController(window, window.decorView)
      .apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.statusBars())
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
    pendingIntentRouter.onNewIntent(intent) { routedIntent ->
      initializedViewModel?.let { handleAssistantIntent(viewModel = it, intent = routedIntent) }
    }
  }

  /**
   * Wires MainViewModel only after Activity first draw and background prefs warm-up.
   */
  private fun activateViewModel(readyViewModel: MainViewModel) {
    if (initializedViewModel != null) return
    initializedViewModel = readyViewModel
    readyViewModel.setForeground(foreground)
    startViewModelCollectors(readyViewModel)
    pendingIntentRouter.activate { initialIntent ->
      handleAssistantIntent(viewModel = readyViewModel, intent = initialIntent)
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
          runtimeUiStarter.onRuntimeInitialized(
            ready = ready,
            startRuntimeUi = screenshotScene == null,
            attachRuntimeUi = {
              // Runtime UI helpers need an Activity owner, so attach once after NodeRuntime is ready.
              readyViewModel.attachRuntimeUi(owner = this@MainActivity, permissionRequester = permissionRequester)
            },
            startNodeService = {
              NodeForegroundService.start(this@MainActivity)
            },
          )
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

/** Holds launch intents until ViewModel activation, then routes every later intent immediately. */
internal class MainActivityPendingIntentRouter {
  private var activated = false
  private var pendingIntent: Intent? = null

  fun setInitialIntent(intent: Intent?) {
    if (!activated) pendingIntent = intent
  }

  fun onNewIntent(
    intent: Intent,
    routeIntent: (Intent) -> Unit,
  ) {
    if (activated) {
      routeIntent(intent)
      return
    }
    pendingIntent = intent
  }

  fun activate(routeIntent: (Intent) -> Unit): Boolean {
    if (activated) return false
    activated = true
    pendingIntent?.let(routeIntent)
    pendingIntent = null
    return true
  }
}

/** Preserves one-shot runtime UI startup while allowing screenshot fixtures to skip side effects. */
internal class MainActivityRuntimeUiStarter {
  private var completed = false

  fun onRuntimeInitialized(
    ready: Boolean,
    startRuntimeUi: Boolean,
    attachRuntimeUi: () -> Unit,
    startNodeService: () -> Unit,
  ) {
    if (!ready || completed) return
    if (!startRuntimeUi) {
      completed = true
      return
    }
    attachRuntimeUi()
    completed = true
    startNodeService()
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
