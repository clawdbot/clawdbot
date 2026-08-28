package ai.openclaw.app.accessibility

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.OpenClawTheme
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val DELAYED_OBSERVE_SECONDS = 3

class AccessibilityDevActivity : AppCompatActivity() {
  private val executor = AccessibilityActionExecutor()
  private var delayedObserveJob: Job? = null
  private var foregroundPackageName by mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      OpenClawTheme {
        AccessibilityDevScreen(
          executor = executor,
          captureSnapshot = ::captureSnapshotOffMain,
          foregroundPackageName = foregroundPackageName,
          refreshForegroundPackage = ::refreshForegroundPackage,
          startDelayedObserve = ::startDelayedObserve,
          cancelDelayedObserve = ::cancelDelayedObserve,
          openAccessibilitySettings = {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
          },
        )
      }
    }
  }

  override fun onDestroy() {
    cancelDelayedObserve()
    executor.close()
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    refreshForegroundPackage()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) refreshForegroundPackage()
  }

  private fun startDelayedObserve(
    onCountdown: (Int) -> Unit,
    onResult: (Result<MobileUiSnapshot>) -> Unit,
  ) {
    cancelDelayedObserve()
    delayedObserveJob =
      lifecycleScope.launch {
        for (remaining in DELAYED_OBSERVE_SECONDS downTo 1) {
          onCountdown(remaining)
          delay(1_000)
        }
        onResult(runCatching { captureSnapshotOffMain() })
      }
  }

  private fun cancelDelayedObserve() {
    delayedObserveJob?.cancel()
    delayedObserveJob = null
  }

  private fun refreshForegroundPackage() {
    foregroundPackageName = OpenClawAccessibilityService.instance?.foregroundPackageName()
  }

  private suspend fun captureSnapshotOffMain(): MobileUiSnapshot =
    withContext(Dispatchers.Default) {
      // Accessibility tree traversal can involve thousands of blocking IPC calls; keep it off Main.
      executor.observe()
    }
}

@Composable
private fun AccessibilityDevScreen(
  executor: AccessibilityActionExecutor,
  captureSnapshot: suspend () -> MobileUiSnapshot,
  foregroundPackageName: String?,
  refreshForegroundPackage: () -> Unit,
  startDelayedObserve: (
    onCountdown: (Int) -> Unit,
    onResult: (Result<MobileUiSnapshot>) -> Unit,
  ) -> Unit,
  cancelDelayedObserve: () -> Unit,
  openAccessibilitySettings: () -> Unit,
) {
  val coroutineScope = rememberCoroutineScope()
  val serviceConnection by OpenClawAccessibilityService.connection.collectAsState()
  val connected = serviceConnection.instance != null
  var snapshot by remember { mutableStateOf<MobileUiSnapshot?>(null) }
  var selectedRef by remember { mutableStateOf<String?>(null) }
  var textInput by remember { mutableStateOf("") }
  var lastResult by remember { mutableStateOf<ActionResult?>(null) }
  var progressMessage by remember { mutableStateOf<String?>(null) }
  var delayedObserveRunning by remember { mutableStateOf(false) }
  var immediateObserveRunning by remember { mutableStateOf(false) }

  fun applyObservedSnapshot(observed: MobileUiSnapshot) {
    snapshot = observed
    selectedRef = null
    textInput = ""
    lastResult =
      ActionResult(
        ActionOutcomeCode.Completed,
        nativeString("Observed nodes: \$count", observed.nodes.size),
      )
    refreshForegroundPackage()
  }

  fun applyObserveFailure(error: Throwable) {
    snapshot = null
    selectedRef = null
    lastResult = ActionResult(ActionOutcomeCode.ServiceDisabled, error.message)
  }

  fun observe() {
    if (immediateObserveRunning || delayedObserveRunning) return
    cancelDelayedObserve()
    delayedObserveRunning = false
    immediateObserveRunning = true
    progressMessage = nativeString("Observing…")
    coroutineScope.launch {
      val result = runCatching { captureSnapshot() }
      immediateObserveRunning = false
      progressMessage = null
      result.fold(
        onSuccess = ::applyObservedSnapshot,
        onFailure = ::applyObserveFailure,
      )
    }
  }

  fun observeDelayed() {
    if (immediateObserveRunning || delayedObserveRunning) return
    delayedObserveRunning = true
    startDelayedObserve(
      { remaining ->
        progressMessage =
          nativeString(
            "Observing in \${remaining}s — switch to the target app",
            remaining,
          )
      },
      { result ->
        delayedObserveRunning = false
        progressMessage = null
        result.fold(
          onSuccess = ::applyObservedSnapshot,
          onFailure = ::applyObserveFailure,
        )
      },
    )
  }

  fun cancelDelayedObservation() {
    cancelDelayedObserve()
    delayedObserveRunning = false
    progressMessage = null
  }

  fun startImmediateObservation() {
    if (delayedObserveRunning) {
      cancelDelayedObservation()
    }
    observe()
  }

  fun act(action: MobileUiAction) {
    val activeSnapshot = snapshot ?: return
    coroutineScope.launch {
      lastResult = executor.act(activeSnapshot.id, action)
    }
  }

  fun actGlobal(name: GlobalActionName) {
    coroutineScope.launch {
      lastResult = executor.act(snapshot?.id.orEmpty(), MobileUiAction.GlobalAction(name))
    }
  }

  val selectedNode = snapshot?.nodes?.firstOrNull { it.ref == selectedRef }
  val observeRunning = immediateObserveRunning || delayedObserveRunning
  val targetPackageMatches = canRunNodeActions(snapshot?.packageName, foregroundPackageName)
  val nodeActionsEnabled = targetPackageMatches && !observeRunning
  val snapshotLabel = snapshot?.id ?: nativeString("none")
  val snapshotPackage = snapshot?.packageName ?: nativeString("none")
  val foregroundPackage = foregroundPackageName ?: nativeString("unknown")
  Surface(
    modifier =
      Modifier
        .fillMaxSize()
        .statusBarsPadding()
        .navigationBarsPadding(),
    color = MaterialTheme.colorScheme.background,
  ) {
    Column(
      modifier = Modifier.fillMaxSize().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text(nativeString("Accessibility executor"), style = MaterialTheme.typography.headlineSmall)
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Text(
          text =
            if (connected) {
              nativeString("Service connected")
            } else {
              nativeString("Service disabled")
            },
          color = if (connected) Color(0xFF2E7D32) else MaterialTheme.colorScheme.error,
          modifier = Modifier.weight(1f),
        )
        if (!connected) {
          OutlinedButton(onClick = openAccessibilitySettings) {
            Text(nativeString("Open settings"))
          }
        }
      }

      Row(
        modifier = Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Button(onClick = ::startImmediateObservation, enabled = connected && !observeRunning) {
          Text(nativeString("Observe"))
        }
        OutlinedButton(onClick = ::observeDelayed, enabled = connected && !observeRunning) {
          Text(nativeString("Observe in 3s"))
        }
        GlobalActionButton(nativeString("Back"), connected && !observeRunning) {
          actGlobal(GlobalActionName.Back)
        }
        GlobalActionButton(nativeString("Home"), connected && !observeRunning) {
          actGlobal(GlobalActionName.Home)
        }
        GlobalActionButton(nativeString("Recents"), connected && !observeRunning) {
          actGlobal(GlobalActionName.Recents)
        }
      }

      Text(
        text = nativeString("Snapshot: \$snapshotLabel", snapshotLabel),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )
      Text(
        text =
          nativeString(
            "Packages: snapshot=\$snapshotPackage foreground=\$foregroundPackage",
            snapshotPackage,
            foregroundPackage,
          ),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )
      Text(
        text =
          progressMessage ?: lastResult?.let { result ->
            // Action messages are protocol diagnostics; keep them verbatim so UI evidence
            // matches the mobile.ui result returned to the agent.
            listOfNotNull(result.code.value, result.message).joinToString(" — ")
          } ?: nativeString("No action result"),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )

      selectedNode?.let { node ->
        SelectedNodeControls(
          node = node,
          textInput = textInput,
          onTextInputChange = { textInput = it },
          actionsEnabled = nodeActionsEnabled,
          showTargetMismatchNote = !targetPackageMatches,
          act = ::act,
        )
      }

      LazyColumn(
        modifier = Modifier.fillMaxWidth().weight(1f),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        items(snapshot?.nodes.orEmpty(), key = MobileUiNode::ref) { node ->
          NodeRow(
            node = node,
            selected = node.ref == selectedRef,
            onSelect = {
              refreshForegroundPackage()
              selectedRef = node.ref
            },
          )
        }
      }
    }
  }
}

@Composable
private fun GlobalActionButton(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  OutlinedButton(onClick = onClick, enabled = enabled) {
    Text(label)
  }
}

@Composable
private fun SelectedNodeControls(
  node: MobileUiNode,
  textInput: String,
  onTextInputChange: (String) -> Unit,
  actionsEnabled: Boolean,
  showTargetMismatchNote: Boolean,
  act: (MobileUiAction) -> Unit,
) {
  Card(modifier = Modifier.fillMaxWidth()) {
    Column(
      modifier = Modifier.padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        nativeString("Selected \$reference", node.ref),
        style = MaterialTheme.typography.titleSmall,
      )
      if (showTargetMismatchNote) {
        Text(
          nativeString(
            "Node actions run only when the target app is foreground (validated via the remote path). Global actions and same-app actions work here.",
          ),
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      Row(
        modifier = Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        if ("activate" in node.actions) {
          Button(onClick = { act(MobileUiAction.Activate(node.ref)) }, enabled = actionsEnabled) {
            Text(nativeString("Activate"))
          }
        }
        if ("scroll_forward" in node.actions) {
          OutlinedButton(
            onClick = { act(MobileUiAction.Scroll(node.ref, ScrollDirection.Forward)) },
            enabled = actionsEnabled,
          ) {
            Text(nativeString("Scroll forward"))
          }
        }
        if ("scroll_backward" in node.actions) {
          OutlinedButton(
            onClick = { act(MobileUiAction.Scroll(node.ref, ScrollDirection.Backward)) },
            enabled = actionsEnabled,
          ) {
            Text(nativeString("Scroll back"))
          }
        }
      }
      if (node.editable && "set_text" in node.actions) {
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          OutlinedTextField(
            value = textInput,
            onValueChange = onTextInputChange,
            label = { Text(nativeString("Text")) },
            singleLine = true,
            enabled = actionsEnabled,
            modifier = Modifier.weight(1f),
          )
          Button(
            onClick = { act(MobileUiAction.SetText(node.ref, textInput)) },
            enabled = actionsEnabled,
          ) {
            Text(nativeString("Set text"))
          }
        }
      }
    }
  }
}

internal fun canRunNodeActions(
  snapshotPackageName: String?,
  foregroundPackageName: String?,
): Boolean = snapshotPackageName != null && snapshotPackageName == foregroundPackageName

@Composable
private fun NodeRow(
  node: MobileUiNode,
  selected: Boolean,
  onSelect: () -> Unit,
) {
  val selectionMarker = if (selected) "▶ " else ""
  Card(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
    shape = RoundedCornerShape(8.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(10.dp),
      verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
      Text(
        text =
          selectionMarker +
            nativeString(
              "\$reference  \$role",
              node.ref,
              node.role,
            ),
        style = MaterialTheme.typography.titleSmall,
        fontFamily = FontFamily.Monospace,
      )
      node.text?.let {
        Text(
          nativeString("text: \$value", it),
          style = MaterialTheme.typography.bodySmall,
        )
      }
      node.contentDescription?.let {
        Text(
          nativeString("description: \$value", it),
          style = MaterialTheme.typography.bodySmall,
        )
      }
      Text(
        text =
          nativeString(
            "bounds: \$value",
            node.boundsInScreen.flattenToString(),
          ),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )
      Text(
        text =
          nativeString(
            "actions: \$value",
            node.actions.joinToString().ifEmpty { nativeString("none") },
          ),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
      )
    }
  }
}
