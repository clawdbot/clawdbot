package ai.openclaw.app

import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.ChatCacheScope
import ai.openclaw.app.chat.ChatCommandEntry
import ai.openclaw.app.chat.ChatCommandOutbox
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatPlanStep
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatSessionDeletion
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatThinkingLevelSelection
import ai.openclaw.app.chat.ChatTranscriptCache
import ai.openclaw.app.chat.ChatWidgetResource
import ai.openclaw.app.chat.ChatWidgetSurface
import ai.openclaw.app.chat.ChatWidgetSurfaceUrls
import ai.openclaw.app.chat.ChatWidgetUrlResolver
import ai.openclaw.app.chat.GatewayDefaultAgentOwner
import ai.openclaw.app.chat.MainSessionBinding
import ai.openclaw.app.chat.MessageSpeechClient
import ai.openclaw.app.chat.MessageSpeechController
import ai.openclaw.app.chat.MessageSpeechState
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.chat.SystemSpeechSpeaker
import ai.openclaw.app.gateway.DeviceAuthEntry
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayDiscovery
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayEvent
import ai.openclaw.app.gateway.GatewayMethod
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.gateway.GatewayTlsTrustDecision
import ai.openclaw.app.gateway.GatewayUpdateAvailableSummary
import ai.openclaw.app.gateway.NetworkMonitor
import ai.openclaw.app.gateway.NodeEventSendOutcome
import ai.openclaw.app.gateway.decideGatewayTlsTrust
import ai.openclaw.app.gateway.formatGatewayAuthority
import ai.openclaw.app.gateway.isGatewayTlsSystemTrustCandidate
import ai.openclaw.app.gateway.normalizeGatewayApprovalRequestId
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprintInput
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.gateway.probeGatewayTlsFingerprint
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeLocaleChanges
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveOptionalNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.A2UIHandler
import ai.openclaw.app.node.CalendarHandler
import ai.openclaw.app.node.CallLogHandler
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.CameraHandler
import ai.openclaw.app.node.CanvasController
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.ContactsHandler
import ai.openclaw.app.node.DEFAULT_SEAM_COLOR_ARGB
import ai.openclaw.app.node.DebugHandler
import ai.openclaw.app.node.DeviceHandler
import ai.openclaw.app.node.DeviceNotificationListenerService
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.node.LocationCaptureManager
import ai.openclaw.app.node.LocationHandler
import ai.openclaw.app.node.MotionHandler
import ai.openclaw.app.node.NodePresenceAliveBeacon
import ai.openclaw.app.node.NotificationsHandler
import ai.openclaw.app.node.PhotosHandler
import ai.openclaw.app.node.Quad
import ai.openclaw.app.node.SmsHandler
import ai.openclaw.app.node.SmsManager
import ai.openclaw.app.node.SystemHandler
import ai.openclaw.app.node.TalkHandler
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import ai.openclaw.app.node.invokeErrorFromThrowable
import ai.openclaw.app.node.parseHexColorArgb
import ai.openclaw.app.protocol.OpenClawCanvasA2UIAction
import ai.openclaw.app.voice.AndroidOnDeviceVoiceWakeRecognizer
import ai.openclaw.app.voice.GatewayTranscriptionSession
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.PreviewVoiceWakeRecognizer
import ai.openclaw.app.voice.TalkAudioPlayer
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.TalkPttOnceStart
import ai.openclaw.app.voice.TalkPttStopPayload
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import ai.openclaw.app.voice.VoiceWakeManager
import ai.openclaw.app.voice.VoiceWakeMatch
import ai.openclaw.app.voice.VoiceWakePreferences
import ai.openclaw.app.voice.VoiceWakeSuppressionReason
import ai.openclaw.app.wear.WearProxyAgent
import ai.openclaw.app.wear.WearProxyBridge
import ai.openclaw.app.wear.WearProxyController
import ai.openclaw.app.wear.WearProxyGatewayException
import ai.openclaw.app.wear.WearProxyModel
import ai.openclaw.app.wear.WearRealtimeTalkController
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val MAX_PENDING_NOTIFICATION_EVENTS = 128
private const val NODE_APPROVAL_COMMAND_FRESH_MS = 30_000L
private const val CRON_RUN_TRACKING_POLL_MS = 2_000L
private const val CRON_JOBS_PAGE_SIZE = 200
private const val CRON_JOBS_MAX_PAGES = 100
private const val CRON_JOBS_MAX_COUNT = CRON_JOBS_PAGE_SIZE * CRON_JOBS_MAX_PAGES
private const val CRON_JOBS_SNAPSHOT_MAX_ATTEMPTS = 3
private const val OperatorAdminScope = "operator.admin"
private const val OperatorPairingScope = "operator.pairing"

private fun execApprovalOutcomeUnknownMessage(): String = nativeText("Resolution outcome unknown. Actions stay disabled until the Gateway record is verified.").source

private fun execApprovalStillPendingMessage(): String = nativeText("The Gateway still shows this approval as pending. Review it before trying again.").source

private fun execApprovalLoadDetailsFailureMessage(): String = nativeText("Could not load approval details. Refresh and try again.").source

private fun execApprovalLoadFailureMessage(): String = nativeText("Could not load approvals.").source

private fun execApprovalResolveFailureMessage(): String = nativeText("Could not resolve approval. Refresh and try again.").source

internal typealias GatewayDataRequestOverride =
  suspend (stableId: String, method: String, paramsJson: String?) -> String

private class ExecApprovalWriteOutcomeUnknown : IllegalStateException("approval resolve response was not authoritative")

private class GatewayApprovalRpcUnavailable : IllegalStateException("Gateway approval RPC catalog is inconsistent")

data class GatewayDevicePairingCapabilities(
  val canList: Boolean = false,
  val canApprove: Boolean = false,
  val canReject: Boolean = false,
  val canRemove: Boolean = false,
) {
  val canManage: Boolean
    get() = canList && (canApprove || canReject || canRemove)

  internal fun supports(action: GatewayDevicePairingAction): Boolean =
    canList &&
      when (action) {
        GatewayDevicePairingAction.Approve -> canApprove
        GatewayDevicePairingAction.Reject -> canReject
        GatewayDevicePairingAction.Remove -> canRemove
      }
}

internal fun selectGatewayDevicePairingCapabilities(
  methods: Set<String>,
  scopes: List<String>,
): GatewayDevicePairingCapabilities {
  // Extending the limited mobile bootstrap profile with pairing is a gateway-side
  // product decision; this UI only reflects hello-granted scopes and methods.
  val hasPairingScope = scopes.any { it == OperatorPairingScope || it == OperatorAdminScope }
  if (!hasPairingScope) return GatewayDevicePairingCapabilities()
  val hasAdminScope = OperatorAdminScope in scopes
  return GatewayDevicePairingCapabilities(
    canList = "device.pair.list" in methods,
    canApprove = "device.pair.approve" in methods,
    canReject = "device.pair.reject" in methods,
    canRemove = hasAdminScope && "device.pair.remove" in methods,
  )
}

/**
 * Mirrors the gateway's non-admin approval checks for the requested access set.
 * See src/gateway/server-methods/devices.ts:268-331 and src/infra/device-pairing.ts:854-873.
 */
internal fun canApproveGatewayDevicePairing(
  capabilities: GatewayDevicePairingCapabilities,
  callerScopes: List<String>,
  pending: GatewayPendingDeviceSummary,
): Boolean {
  if (!capabilities.supports(GatewayDevicePairingAction.Approve)) return false
  val roles =
    pending.roles
      .map(String::trim)
      .filter(String::isNotEmpty)
      .toSet()
  val scopes =
    pending.scopes
      .map(String::trim)
      .filter(String::isNotEmpty)
      .toSet()
  if (scopes.any { scope -> roles.none { role -> roleAllowsScope(role, scope) } }) return false

  val grantedScopes = callerScopes.map(String::trim).filter(String::isNotEmpty).toSet()
  if (OperatorAdminScope in grantedScopes) return true
  if (roles.any { it != "operator" }) return false
  return scopes.all { scope -> operatorScopeAllowed(scope, grantedScopes) }
}

private fun roleAllowsScope(
  role: String,
  scope: String,
): Boolean =
  if (role == "operator") {
    scope.startsWith("operator.")
  } else {
    scope.startsWith("$role.")
  }

private fun operatorScopeAllowed(
  requestedScope: String,
  grantedScopes: Set<String>,
): Boolean =
  when (requestedScope) {
    "operator.read" -> "operator.read" in grantedScopes || "operator.write" in grantedScopes
    "operator.write" -> "operator.write" in grantedScopes
    else -> requestedScope in grantedScopes
  }

enum class GatewayDevicePairingAction(
  internal val method: String,
  internal val idKey: String,
  internal val successNotice: NativeText,
) {
  Approve("device.pair.approve", "requestId", nativeText("Device approved.")),
  Reject("device.pair.reject", "requestId", nativeText("Pairing request rejected.")),
  Remove("device.pair.remove", "deviceId", nativeText("Paired device removed.")),
}

data class GatewayDevicePairingMutation(
  val action: GatewayDevicePairingAction,
  val targetId: String,
)

internal sealed interface GatewayDevicePairingMutationOutcome {
  data object Approved : GatewayDevicePairingMutationOutcome

  data object Rejected : GatewayDevicePairingMutationOutcome

  data object Removed : GatewayDevicePairingMutationOutcome

  data object NotVerified : GatewayDevicePairingMutationOutcome
}

internal fun verifyGatewayDevicePairingMutation(
  mutation: GatewayDevicePairingMutation,
  expectedDeviceId: String,
  mutationAccepted: Boolean,
  pending: List<GatewayPendingDeviceSummary>,
  paired: List<GatewayPairedDeviceSummary>,
): GatewayDevicePairingMutationOutcome =
  if (!mutationAccepted) {
    GatewayDevicePairingMutationOutcome.NotVerified
  } else {
    when (mutation.action) {
      GatewayDevicePairingAction.Approve ->
        if (
          pending.none { it.requestId == mutation.targetId } &&
          paired.any { it.deviceId == expectedDeviceId }
        ) {
          GatewayDevicePairingMutationOutcome.Approved
        } else {
          GatewayDevicePairingMutationOutcome.NotVerified
        }
      GatewayDevicePairingAction.Reject ->
        if (pending.none { it.requestId == mutation.targetId }) {
          GatewayDevicePairingMutationOutcome.Rejected
        } else {
          GatewayDevicePairingMutationOutcome.NotVerified
        }
      GatewayDevicePairingAction.Remove ->
        if (paired.none { it.deviceId == mutation.targetId }) {
          GatewayDevicePairingMutationOutcome.Removed
        } else {
          GatewayDevicePairingMutationOutcome.NotVerified
        }
    }
  }

internal fun buildGatewayDevicePairingMutationParams(mutation: GatewayDevicePairingMutation): JsonObject = buildJsonObject { put(mutation.action.idKey, JsonPrimitive(mutation.targetId)) }

internal enum class SkillWorkshopGatewayAction(
  val methodSuffix: String,
  val expectedStatus: String,
  val notice: NativeText,
  val verb: NativeText,
) {
  Apply("apply", "applied", nativeText("Proposal applied."), nativeText("apply")),
  Reject("reject", "rejected", nativeText("Proposal rejected."), nativeText("reject")),
  Quarantine("quarantine", "quarantined", nativeText("Proposal quarantined."), nativeText("quarantine")),
}

internal fun skillWorkshopUnexpectedStatusText(
  status: String?,
  action: SkillWorkshopGatewayAction,
): NativeText {
  val statusText = status?.takeIf { it.isNotBlank() }?.let(::verbatimText) ?: nativeText("unknown")
  return nativeText(
    "Gateway returned status '\$statusLabel' after \${action.verb}.",
    statusText,
    action.verb,
  )
}

internal fun skillWorkshopActionFailureText(action: SkillWorkshopGatewayAction): NativeText =
  nativeText(
    "Could not \${action.verb} Skill Workshop proposal.",
    action.verb,
  )

internal data class PendingNotificationNodeEvent(
  val event: String,
  val payloadJson: String?,
  val gatewayId: String? = null,
)

private data class QueuedNotificationNodeEvent(
  val generation: Long,
  val event: PendingNotificationNodeEvent,
)

internal class NotificationNodeEventOutbox(
  private val capacity: Int = MAX_PENDING_NOTIFICATION_EVENTS,
  private val isAuthorized: (PendingNotificationNodeEvent) -> Boolean = { true },
  private val isConnected: () -> Boolean = { true },
  private val deliveryIntervalMs: () -> Long = { 0L },
  private val nowEpochMs: () -> Long = System::currentTimeMillis,
  private val sleep: suspend (Long) -> Unit = { delay(it) },
  private val invalidateConnection: () -> Unit = {},
  private val send: suspend (PendingNotificationNodeEvent) -> NodeEventSendOutcome,
) {
  private val stateLock = Any()
  private val generation = AtomicLong()
  private val lastDeliveryAtMs = AtomicLong(-1L)
  private val pending = ArrayDeque<QueuedNotificationNodeEvent>(capacity)
  private val wakeDelivery = Channel<Unit>(Channel.CONFLATED)
  private var inFlight: QueuedNotificationNodeEvent? = null

  init {
    require(capacity > 0) { "capacity must be positive" }
  }

  fun enqueue(event: PendingNotificationNodeEvent) {
    synchronized(stateLock) {
      if (pending.size == capacity) pending.removeFirst()
      pending.addLast(QueuedNotificationNodeEvent(generation = generation.get(), event = event))
    }
    wakeDelivery.trySend(Unit)
  }

  fun clear() {
    synchronized(stateLock) {
      clearLocked()
    }
    wakeDelivery.trySend(Unit)
  }

  fun <T> updatePolicy(update: () -> T): T {
    val result =
      synchronized(stateLock) {
        // Admission checks share this lock, so the new policy is visible before the next generation.
        update().also { clearLocked() }
      }
    wakeDelivery.trySend(Unit)
    return result
  }

  fun onConnected() {
    wakeDelivery.trySend(Unit)
  }

  suspend fun deliver() {
    while (true) {
      wakeDelivery.receive()
      while (true) {
        val queued = synchronized(stateLock) { pending.firstOrNull() } ?: break
        if (queued.generation != generation.get() || !isAuthorized(queued.event)) {
          synchronized(stateLock) {
            if (pending.firstOrNull() === queued) pending.removeFirst()
          }
          continue
        }
        if (!isConnected()) break
        if (!awaitDeliverySlot(queued)) continue
        val admitted =
          synchronized(stateLock) {
            if (
              pending.firstOrNull() !== queued ||
              queued.generation != generation.get() ||
              !isAuthorized(queued.event) ||
              !isConnected()
            ) {
              false
            } else {
              pending.removeFirst()
              inFlight = queued
              true
            }
          }
        if (!admitted) continue

        val outcome = send(queued.event)
        synchronized(stateLock) {
          if (inFlight === queued) inFlight = null
          if (queued.generation == generation.get() && isAuthorized(queued.event)) {
            when (outcome) {
              NodeEventSendOutcome.COMPLETED -> lastDeliveryAtMs.set(nowEpochMs())
              NodeEventSendOutcome.DISCONNECTED -> {
                // This outcome is rejected before send, so it is safe to retain for reconnect.
                if (pending.size == capacity) pending.removeLast()
                pending.addFirst(queued)
              }
              // Ambiguous failures may have reached the gateway: do not retry, but charge their rate slot.
              NodeEventSendOutcome.FAILED -> lastDeliveryAtMs.set(nowEpochMs())
            }
          }
        }
        if (outcome == NodeEventSendOutcome.DISCONNECTED) break
      }
    }
  }

  private suspend fun awaitDeliverySlot(queued: QueuedNotificationNodeEvent): Boolean {
    while (queued.generation == generation.get() && isAuthorized(queued.event)) {
      val lastDelivery = lastDeliveryAtMs.get()
      if (lastDelivery < 0L) return true
      val waitMs = lastDelivery + deliveryIntervalMs().coerceAtLeast(0L) - nowEpochMs()
      if (waitMs <= 0L) return true
      // Short slices make policy/gateway invalidation responsive without charging stale quota.
      sleep(minOf(waitMs, 250L))
    }
    return false
  }

  private fun clearLocked() {
    // Only an admitted RPC needs transport invalidation; queued payloads have no socket side effect.
    if (inFlight?.generation == generation.get()) invalidateConnection()
    generation.incrementAndGet()
    lastDeliveryAtMs.set(-1L)
    pending.clear()
  }
}

/**
 * Process runtime that owns gateway sessions, node command handlers, capture managers, and UI-facing state.
 */
data class GatewayConnectionProblem(
  val code: String?,
  val message: String,
  val reason: String?,
  val requestId: String?,
  val recommendedNextStep: String?,
  val pauseReconnect: Boolean,
  val retryable: Boolean,
  val clientMinProtocol: Int? = null,
  val clientMaxProtocol: Int? = null,
  val expectedProtocol: Int? = null,
  val minimumProbeProtocol: Int? = null,
) {
  val isPairingRequired: Boolean = code == "PAIRING_REQUIRED"
  val canAutoRetry: Boolean =
    isPairingRequired &&
      (
        retryable ||
          !pauseReconnect ||
          recommendedNextStep == "wait_then_retry"
      )
}

data class GatewayConnectionDisplay(
  val isConnected: Boolean,
  val statusText: String,
  val problem: GatewayConnectionProblem?,
)

private const val GATEWAY_STATUS_OFFLINE = "Offline"
private const val GATEWAY_STATUS_CONNECTED = "Connected"
private const val GATEWAY_STATUS_NODE_OFFLINE = "Connected (node offline)"
private const val GATEWAY_STATUS_OPERATOR_OFFLINE = "Connected (operator offline)"

private fun gatewayOperatorConnectionState(operator: String): String = "Connected (operator: $operator)"

internal fun gatewayConnectionStatusForDisplay(statusText: String): String {
  val status = statusText.trim()
  return when {
    status.isEmpty() || status == GATEWAY_STATUS_OFFLINE -> nativeString("Offline")
    status == GATEWAY_STATUS_CONNECTED -> nativeString("Connected")
    status == GATEWAY_STATUS_NODE_OFFLINE -> nativeString("Connected (node offline)")
    status == GATEWAY_STATUS_OPERATOR_OFFLINE -> nativeString("Connected (operator offline)")
    status == "Connecting…" -> nativeString("Connecting…")
    status == "Reconnecting…" -> nativeString("Reconnecting…")
    status == "Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected." ->
      nativeString("Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected.")
    status == "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry." ->
      nativeString("Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry.")
    status == "Failed: couldn't reach the secure gateway endpoint for this host." ->
      nativeString("Failed: couldn't reach the secure gateway endpoint for this host.")
    status.startsWith("Connected (operator: ") && status.endsWith(")") ->
      nativeString(
        "Connected (operator: \$operator)",
        status.removePrefix("Connected (operator: ").dropLast(1),
      )
    else -> status
  }
}

private fun gatewayProblemAfterDisconnect(
  problem: GatewayConnectionProblem?,
  statusText: String,
): GatewayConnectionProblem? =
  // Automatic bootstrap pairing retries need their approval guidance until success or a different failure.
  problem?.takeIf { statusText == "Reconnecting…" && it.canAutoRetry }

internal fun gatewayConnectionDisplay(
  operatorConnected: Boolean,
  nodeConnected: Boolean,
  operatorStatusText: String,
  nodeStatusText: String,
  operatorProblem: GatewayConnectionProblem?,
  nodeProblem: GatewayConnectionProblem?,
): GatewayConnectionDisplay {
  val operator = operatorStatusText.trim()
  val node = nodeStatusText.trim()
  return when {
    operatorConnected && nodeConnected -> GatewayConnectionDisplay(true, GATEWAY_STATUS_CONNECTED, null)
    operatorConnected -> GatewayConnectionDisplay(true, GATEWAY_STATUS_NODE_OFFLINE, nodeProblem)
    nodeConnected ->
      GatewayConnectionDisplay(
        isConnected = false,
        statusText =
          if (operator.isNotEmpty() && operator != "Offline") {
            gatewayOperatorConnectionState(operator)
          } else {
            GATEWAY_STATUS_OPERATOR_OFFLINE
          },
        problem = operatorProblem,
      )
    operator.isNotBlank() && operator != "Offline" -> GatewayConnectionDisplay(false, operator, operatorProblem)
    else -> GatewayConnectionDisplay(false, node, nodeProblem)
  }
}

private data class AndroidChatStores(
  val transcriptCache: ChatTranscriptCache,
  val commandOutbox: ChatCommandOutbox,
  val clientDatabases: AndroidClientDatabases,
  val externalTranscriptCache: ChatTranscriptCache? = null,
)

internal enum class NodeRuntimeMode {
  Live,
  ScreenshotFixture,
}

private fun openAndroidChatStores(
  context: Context,
  prefs: SecurePrefs,
): AndroidChatStores {
  val databases =
    AndroidClientDatabases.start(
      context.applicationContext,
      registeredGatewayIds =
        prefs.gatewayRegistry.entries.value
          .map { it.stableId }
          .toSet(),
    )
  return AndroidChatStores(
    transcriptCache = databases.transcriptCache(),
    commandOutbox = databases.commandOutbox(),
    clientDatabases = databases,
  )
}

private fun openAndroidChatStores(
  context: Context,
  prefs: SecurePrefs,
  transcriptCache: ChatTranscriptCache,
): AndroidChatStores {
  val databases =
    AndroidClientDatabases.start(
      context.applicationContext,
      registeredGatewayIds =
        prefs.gatewayRegistry.entries.value
          .map { it.stableId }
          .toSet(),
    )
  return AndroidChatStores(
    transcriptCache = transcriptCache,
    commandOutbox = databases.commandOutbox(),
    clientDatabases = databases,
    externalTranscriptCache = transcriptCache,
  )
}

class NodeRuntime private constructor(
  context: Context,
  val prefs: SecurePrefs,
  private val tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult,
  chatStores: AndroidChatStores,
  internal val mode: NodeRuntimeMode,
  initialForeground: Boolean,
  initialReconnectSuppressed: Boolean,
) {
  private val chatTranscriptCache = chatStores.transcriptCache
  private val chatCommandOutbox = chatStores.commandOutbox
  private val clientDatabases = chatStores.clientDatabases
  private val externalTranscriptCache = chatStores.externalTranscriptCache
  private val gatewayAuthLifecycleLock = Any()
  private var gatewayAuthResetInProgress = false
  private var gatewayConnectOperationsInFlight = 0
  private var gatewayConnectOperationsDrained = CompletableDeferred(Unit)

  @Volatile private var connectingEndpointStableId: String? = null
  private val gatewayDataScopeLock = Any()
  private val gatewaySwitchMutex = Mutex()
  private val inlineWidgetRefreshMutex = Mutex()
  private val gatewayLifecycleIntentLock = Any()
  private val gatewayLifecycleIntentSeq = AtomicLong()
  private var gatewayDataGeneration = 0L

  private data class GatewayDataScope(
    val stableId: String,
    val generation: Long,
  )

  private data class GatewayMethodsSnapshot(
    val approvalRpcFamily: GatewayApprovalRpcFamily,
    val epoch: Long,
  )

  private class PendingExecApprovalWrite(
    val stableId: String,
    val id: String,
    val decision: String,
    // Captured at registration: canonical readback needs it after a refresh has
    // already replaced the visible rows, or the legacy get parse drops the row.
    val createdAtMs: Long?,
  ) {
    @Volatile var requestInFlight: Boolean = true
  }

  private data class CronActionResult(
    val message: NativeText,
    val kind: GatewayCronNoticeKind,
    val refresh: Boolean,
    val deleted: Boolean = false,
  )

  constructor(
    context: Context,
    prefs: SecurePrefs = SecurePrefs(context.applicationContext),
    tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult = ::probeGatewayTlsFingerprint,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = tlsFingerprintProbe,
    chatStores = openAndroidChatStores(context, prefs),
    mode = NodeRuntimeMode.Live,
    initialForeground = true,
    initialReconnectSuppressed = false,
  )

  internal constructor(
    context: Context,
    prefs: SecurePrefs,
    initialForeground: Boolean,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
    chatStores = openAndroidChatStores(context, prefs),
    mode = NodeRuntimeMode.Live,
    initialForeground = initialForeground,
    initialReconnectSuppressed = false,
  )

  internal constructor(
    context: Context,
    prefs: SecurePrefs,
    mode: NodeRuntimeMode,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
    chatStores = openAndroidChatStores(context, prefs),
    mode = mode,
    initialForeground = true,
    initialReconnectSuppressed = false,
  )

  internal constructor(
    context: Context,
    prefs: SecurePrefs,
    chatTranscriptCache: ChatTranscriptCache,
  ) : this(
    context = context,
    prefs = prefs,
    tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
    chatStores = openAndroidChatStores(context, prefs, chatTranscriptCache),
    mode = NodeRuntimeMode.Live,
    initialForeground = true,
    initialReconnectSuppressed = false,
  )

  companion object {
    internal fun forGatewayAuthReset(
      context: Context,
      prefs: SecurePrefs,
    ): NodeRuntime =
      NodeRuntime(
        context = context,
        prefs = prefs,
        tlsFingerprintProbe = ::probeGatewayTlsFingerprint,
        chatStores = openAndroidChatStores(context, prefs),
        mode = NodeRuntimeMode.Live,
        initialForeground = true,
        initialReconnectSuppressed = true,
      )
  }

  /**
   * Authentication material supplied by setup/manual connect flows before gateway session routing.
   */
  data class GatewayConnectAuth(
    val token: String?,
    val bootstrapToken: String?,
    val password: String?,
  )

  /**
   * HTTP(S) page origin of the connected gateway plus the shared credential a
   * gateway-served page (e.g. the `?view=terminal` Control UI document) can
   * authenticate with. Derived from the same endpoint/auth the WS sessions use.
   */
  data class GatewayControlPage(
    val baseUrl: String,
    val token: String?,
    val password: String?,
  )

  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val deviceAuthStore = DeviceAuthStore(prefs)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext) { prefs.preferredCameraFacing.value }
  val location = LocationCaptureManager(appContext)
  val sms = SmsManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val voiceWakeManager =
    VoiceWakeManager(
      context = appContext,
      scope = scope,
      recognizer =
        when (mode) {
          NodeRuntimeMode.Live -> AndroidOnDeviceVoiceWakeRecognizer(appContext)
          NodeRuntimeMode.ScreenshotFixture -> PreviewVoiceWakeRecognizer()
        },
      initialTriggerWords = VoiceWakePreferences.defaultTriggerWords,
      onCommand = ::sendVoiceWakeCommand,
    )
  val voiceWakeAvailable: StateFlow<Boolean> = MutableStateFlow(voiceWakeManager.isAvailable).asStateFlow()
  val voiceWakeEnabled: StateFlow<Boolean> = prefs.voiceWakeEnabled
  val voiceWakeWords: StateFlow<List<String>> = prefs.voiceWakeWords
  val voiceWakeIsListening: StateFlow<Boolean> = voiceWakeManager.isListening
  val voiceWakeStatusText: StateFlow<String> = voiceWakeManager.statusText
  val voiceWakeLastTriggeredCommand: StateFlow<String?> = voiceWakeManager.lastTriggeredCommand
  private val voiceWakeWordsSaveSeq = AtomicLong(0)
  private val voiceWakeWordsLock = Any()
  private var voiceWakeWordsRevision = 0L
  private var voiceWakeWordsGatewayStableId: String? = null
  private val _voiceWakeWordsSaving = MutableStateFlow(false)
  val voiceWakeWordsSaving: StateFlow<Boolean> = _voiceWakeWordsSaving.asStateFlow()
  private val _voiceWakeWordsNoticeText = MutableStateFlow<NativeText?>(null)
  val voiceWakeWordsNoticeText: StateFlow<String?> = _voiceWakeWordsNoticeText.resolveOptionalNativeText()

  private val externalAudioCaptureActive = MutableStateFlow(false)
  private val _voiceCaptureMode = MutableStateFlow(VoiceCaptureMode.Off)
  val voiceCaptureMode: StateFlow<VoiceCaptureMode> = _voiceCaptureMode.asStateFlow()
  private val _activeAudioInputDevicePreference = MutableStateFlow<String?>(null)
  val activeAudioInputDevicePreference: StateFlow<String?> = _activeAudioInputDevicePreference.asStateFlow()

  private val discovery = GatewayDiscovery(appContext, scope = scope)
  val gateways: StateFlow<List<GatewayEndpoint>> = discovery.gateways
  val discoveryStatusText: StateFlow<String> = discovery.statusText

  private val identityStore = DeviceIdentityStore.withPrefs(appContext, prefs)
  private var connectedEndpoint: GatewayEndpoint? = null
  private var activeGatewayAuth: GatewayConnectAuth? = null

  private val cameraHandler: CameraHandler =
    CameraHandler(
      appContext = appContext,
      camera = camera,
      setCameraAudioCaptureActive = ::setCameraAudioCaptureActive,
      showCameraHud = ::showCameraHud,
      invokeErrorFromThrowable = { invokeErrorFromThrowable(it) },
    )

  private val debugHandler: DebugHandler =
    DebugHandler(
      appContext = appContext,
      identityStore = identityStore,
    )

  private val locationHandler: LocationHandler =
    LocationHandler(
      appContext = appContext,
      location = location,
      json = json,
      isForeground = { _isForeground.value },
      locationMode = { locationMode.value },
      backgroundLocationEnabled = { SensitiveFeatureConfig.backgroundLocationEnabled },
      locationPreciseEnabled = { locationPreciseEnabled.value },
    )

  private val deviceHandler: DeviceHandler =
    DeviceHandler(
      appContext = appContext,
      smsEnabled = SensitiveFeatureConfig.smsEnabled,
      callLogEnabled = SensitiveFeatureConfig.callLogEnabled,
    )

  private val notificationsHandler: NotificationsHandler =
    NotificationsHandler(
      appContext = appContext,
    )

  private val systemHandler: SystemHandler =
    SystemHandler(
      appContext = appContext,
    )

  private val photosHandler: PhotosHandler =
    PhotosHandler(
      appContext = appContext,
    )

  private val contactsHandler: ContactsHandler =
    ContactsHandler(
      appContext = appContext,
    )

  private val calendarHandler: CalendarHandler =
    CalendarHandler(
      appContext = appContext,
    )

  private val callLogHandler: CallLogHandler =
    CallLogHandler(
      appContext = appContext,
    )

  private val motionHandler: MotionHandler =
    MotionHandler(
      appContext = appContext,
    )

  private val smsHandlerImpl: SmsHandler =
    SmsHandler(
      sms = sms,
    )

  private val a2uiHandler: A2UIHandler =
    A2UIHandler(
      canvas = canvas,
      json = json,
    )

  private val connectionManager: ConnectionManager =
    ConnectionManager(
      prefs = prefs,
      cameraEnabled = { cameraEnabled.value },
      locationMode = { locationMode.value },
      motionActivityAvailable = { motionHandler.isActivityAvailable() },
      motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
      sendSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canSendSms() },
      readSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canReadSms() },
      smsSearchPossible = { SensitiveFeatureConfig.smsEnabled && sms.hasTelephonyFeature() },
      callLogAvailable = { SensitiveFeatureConfig.callLogEnabled },
      photosAvailable = { SensitiveFeatureConfig.photosEnabled },
      installedAppsSharingEnabled = { installedAppsSharingEnabled.value },
      voiceWakeAvailable = {
        voiceWakeManager.isAvailable &&
          hasRecordAudioPermission() &&
          isVoiceWakeWordsReadyForCurrentGateway()
      },
      inlineWidgetsAvailable = { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) },
      manualTls = { endpoint ->
        prefs.gatewayRegistry.entries.value
          .firstOrNull { it.stableId == endpoint.stableId }
          ?.tls ?: manualTls.value
      },
    )
  private var lastVoiceWakeCapabilityEnabled = isVoiceWakeCapabilityEnabled()

  private val invokeDispatcher: InvokeDispatcher =
    InvokeDispatcher(
      canvas = canvas,
      cameraHandler = cameraHandler,
      locationHandler = locationHandler,
      deviceHandler = deviceHandler,
      notificationsHandler = notificationsHandler,
      systemHandler = systemHandler,
      talkHandler =
        object : TalkHandler {
          override suspend fun handlePttStart(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttStart()

          override suspend fun handlePttStop(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttStop()

          override suspend fun handlePttCancel(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttCancel()

          override suspend fun handlePttOnce(paramsJson: String?): GatewaySession.InvokeResult = handleTalkPttOnce()
        },
      photosHandler = photosHandler,
      contactsHandler = contactsHandler,
      calendarHandler = calendarHandler,
      motionHandler = motionHandler,
      smsHandler = smsHandlerImpl,
      a2uiHandler = a2uiHandler,
      debugHandler = debugHandler,
      callLogHandler = callLogHandler,
      isForeground = { _isForeground.value },
      cameraEnabled = { cameraEnabled.value },
      locationEnabled = { locationMode.value != LocationMode.Off },
      sendSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canSendSms() },
      readSmsAvailable = { SensitiveFeatureConfig.smsEnabled && sms.canReadSms() },
      smsFeatureEnabled = { SensitiveFeatureConfig.smsEnabled },
      smsTelephonyAvailable = { sms.hasTelephonyFeature() },
      callLogAvailable = { SensitiveFeatureConfig.callLogEnabled },
      photosAvailable = { SensitiveFeatureConfig.photosEnabled },
      installedAppsSharingEnabled = { installedAppsSharingEnabled.value },
      debugBuild = { BuildConfig.DEBUG },
      onCanvasA2uiPush = {
        _canvasA2uiHydrated.value = true
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
      },
      onCanvasA2uiReset = { _canvasA2uiHydrated.value = false },
      motionActivityAvailable = { motionHandler.isActivityAvailable() },
      motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
    )

  /**
   * Pending TLS trust decision when a gateway certificate is new or has changed.
   */
  data class GatewayTrustPrompt(
    val endpoint: GatewayEndpoint,
    val fingerprintSha256: String?,
    val auth: GatewayConnectAuth,
    val previousFingerprintSha256: String? = null,
    val probeFailure: GatewayTlsProbeFailure? = null,
    val systemTrustAvailable: Boolean = false,
  )

  data class VoiceE2eSliceResult(
    val mode: String,
    val status: String,
    val userText: String?,
    val assistantText: String?,
  )

  data class VoiceE2eResult(
    val normal: VoiceE2eSliceResult?,
    val realtime: VoiceE2eSliceResult?,
  )

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()
  private val _gatewayControlPage = MutableStateFlow<GatewayControlPage?>(null)
  val gatewayControlPage: StateFlow<GatewayControlPage?> = _gatewayControlPage.asStateFlow()
  private val _nodeConnected = MutableStateFlow(false)
  val nodeConnected: StateFlow<Boolean> = _nodeConnected.asStateFlow()
  private val _nodeCapabilityApproval = MutableStateFlow<GatewayNodeCapabilityApproval>(GatewayNodeCapabilityApproval.Loading)
  val nodeCapabilityApproval: StateFlow<GatewayNodeCapabilityApproval> = _nodeCapabilityApproval.asStateFlow()

  private val _gatewayConnectionDisplay = MutableStateFlow(GatewayConnectionDisplay(false, GATEWAY_STATUS_OFFLINE, null))
  val gatewayConnectionDisplay: StateFlow<GatewayConnectionDisplay> = _gatewayConnectionDisplay.asStateFlow()
  private val _statusText = MutableStateFlow(GATEWAY_STATUS_OFFLINE)
  val statusText: StateFlow<String> = _statusText.asStateFlow()
  private val _gatewayConnectionProblem = MutableStateFlow<GatewayConnectionProblem?>(null)
  val gatewayConnectionProblem: StateFlow<GatewayConnectionProblem?> = _gatewayConnectionProblem.asStateFlow()
  private val _operatorScopes = MutableStateFlow<List<String>>(emptyList())
  val operatorScopes: StateFlow<List<String>> = _operatorScopes.asStateFlow()
  val operatorAdminScopeAvailable: StateFlow<Boolean> =
    operatorScopes
      .map { scopes -> scopes.any { it == OperatorAdminScope } }
      .stateIn(scope, SharingStarted.Eagerly, false)

  private val _pendingGatewayTrust = MutableStateFlow<GatewayTrustPrompt?>(null)
  val pendingGatewayTrust: StateFlow<GatewayTrustPrompt?> = _pendingGatewayTrust.asStateFlow()
  private val connectAttemptSeq = AtomicLong(0)

  /**
   * Builds the node-owned session key from stable device identity plus optional active agent.
   */
  private fun resolveNodeMainSessionKey(agentId: String? = null): String {
    val deviceId = identityStore.loadOrCreate().deviceId
    return buildNodeMainSessionKey(deviceId, agentId)
  }

  private val _mainSessionKey = MutableStateFlow(resolveNodeMainSessionKey())
  val mainSessionKey: StateFlow<String> = _mainSessionKey.asStateFlow()

  private val cameraHudSeq = AtomicLong(0)
  private val _cameraHud = MutableStateFlow<CameraHudState?>(null)
  val cameraHud: StateFlow<CameraHudState?> = _cameraHud.asStateFlow()

  private val _canvasA2uiHydrated = MutableStateFlow(false)
  val canvasA2uiHydrated: StateFlow<Boolean> = _canvasA2uiHydrated.asStateFlow()
  private val _canvasRehydratePending = MutableStateFlow(false)
  val canvasRehydratePending: StateFlow<Boolean> = _canvasRehydratePending.asStateFlow()
  private val _canvasRehydrateErrorText = MutableStateFlow<NativeText?>(null)
  val canvasRehydrateErrorText: StateFlow<String?> = _canvasRehydrateErrorText.resolveOptionalNativeText()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()

  private val _gatewayVersion = MutableStateFlow<String?>(null)
  val gatewayVersion: StateFlow<String?> = _gatewayVersion.asStateFlow()

  private val _gatewayUpdateAvailable = MutableStateFlow<GatewayUpdateAvailableSummary?>(null)
  val gatewayUpdateAvailable: StateFlow<GatewayUpdateAvailableSummary?> = _gatewayUpdateAvailable.asStateFlow()

  private val _seamColorArgb = MutableStateFlow(DEFAULT_SEAM_COLOR_ARGB)
  val seamColorArgb: StateFlow<Long> = _seamColorArgb.asStateFlow()
  private val _modelCatalog = MutableStateFlow<List<GatewayModelSummary>>(emptyList())
  val modelCatalog: StateFlow<List<GatewayModelSummary>> = _modelCatalog.asStateFlow()
  private val _providerModelCatalog = MutableStateFlow<List<GatewayModelSummary>>(emptyList())
  val providerModelCatalog: StateFlow<List<GatewayModelSummary>> = _providerModelCatalog.asStateFlow()
  private val _providerModelCatalogRefreshing = MutableStateFlow(false)
  val providerModelCatalogRefreshing: StateFlow<Boolean> = _providerModelCatalogRefreshing.asStateFlow()
  private val _providerModelCatalogErrorText = MutableStateFlow<NativeText?>(null)
  val providerModelCatalogErrorText: StateFlow<String?> = _providerModelCatalogErrorText.resolveOptionalNativeText()
  private val providerModelCatalogRefreshGuard = LatestGatewayRefreshGuard()
  private val _modelAuthProviders = MutableStateFlow<List<GatewayModelProviderSummary>>(emptyList())
  val modelAuthProviders: StateFlow<List<GatewayModelProviderSummary>> = _modelAuthProviders.asStateFlow()
  private val _modelCatalogRefreshing = MutableStateFlow(false)
  val modelCatalogRefreshing: StateFlow<Boolean> = _modelCatalogRefreshing.asStateFlow()
  private val _modelCatalogErrorText = MutableStateFlow<NativeText?>(null)
  val modelCatalogErrorText: StateFlow<String?> = _modelCatalogErrorText.resolveOptionalNativeText()
  private val _talkSetupReadiness = MutableStateFlow(GatewayTalkSetupReadiness.unverified())
  val talkSetupReadiness: StateFlow<GatewayTalkSetupReadiness> = _talkSetupReadiness.asStateFlow()
  private val _gatewayDefaultAgentId = MutableStateFlow<String?>(null)
  val gatewayDefaultAgentId: StateFlow<String?> = _gatewayDefaultAgentId.asStateFlow()
  private val gatewayDefaultAgentRevision = AtomicLong(0)
  private var gatewayDefaultAgentStableId: String? = null

  private fun updateGatewayDefaultAgentId(agentId: String?) {
    val normalized = agentId?.trim()?.ifEmpty { null }
    val ownerStableId = normalized?.let { chatCacheGatewayId() }
    if (_gatewayDefaultAgentId.value == normalized && gatewayDefaultAgentStableId == ownerStableId) return
    // Revision first: a send may observe either side of the value write, but never a new
    // owner paired with the previous epoch during an A -> B -> A transition.
    gatewayDefaultAgentRevision.incrementAndGet()
    _gatewayDefaultAgentId.value = normalized
    gatewayDefaultAgentStableId = ownerStableId
    chat.onDefaultAgentChanged(normalized)
  }

  private val _gatewayAgents = MutableStateFlow<List<GatewayAgentSummary>>(emptyList())
  val gatewayAgents: StateFlow<List<GatewayAgentSummary>> = _gatewayAgents.asStateFlow()

  // Preserve an explicit user choice across metadata refreshes. Gateway reconnects
  // clear it so the newly connected gateway's canonical main agent wins again.
  @Volatile private var selectedChatAgentId: String? = null
  private val _cronStatus = MutableStateFlow(GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null))
  val cronStatus: StateFlow<GatewayCronStatus> = _cronStatus.asStateFlow()
  private val _cronJobs = MutableStateFlow<List<GatewayCronJobSummary>>(emptyList())
  val cronJobs: StateFlow<List<GatewayCronJobSummary>> = _cronJobs.asStateFlow()
  private val _cronRefreshing = MutableStateFlow(false)
  val cronRefreshing: StateFlow<Boolean> = _cronRefreshing.asStateFlow()
  private val _cronErrorText = MutableStateFlow<NativeText?>(null)
  val cronErrorText: StateFlow<String?> = _cronErrorText.resolveOptionalNativeText()
  private val _cronJobDetailState = MutableStateFlow<GatewayCronJobDetailState>(GatewayCronJobDetailState.Idle)
  val cronJobDetailState: StateFlow<GatewayCronJobDetailState> = _cronJobDetailState.asStateFlow()
  private val _cronRunHistoryState = MutableStateFlow<GatewayCronRunHistoryState>(GatewayCronRunHistoryState.Idle)
  val cronRunHistoryState: StateFlow<GatewayCronRunHistoryState> = _cronRunHistoryState.asStateFlow()
  private val _cronActionState = MutableStateFlow<GatewayCronActionState>(GatewayCronActionState.Idle)
  val cronActionState: StateFlow<GatewayCronActionState> = _cronActionState.asStateFlow()
  private val _pendingCronRunJobIds = MutableStateFlow<Set<String>>(emptySet())
  val pendingCronRunJobIds: StateFlow<Set<String>> = _pendingCronRunJobIds.asStateFlow()
  private val cronJobDetailRequestGuard = CronJobDetailRequestGuard()
  private val cronRunHistoryRequestGuard = CronJobDetailRequestGuard()
  private val cronRefreshGuard = LatestGatewayRefreshGuard()
  private val cronActionMutex = Mutex()
  private val pendingCronRunRegistry = PendingCronRunRegistry()
  private val _usageSummary = MutableStateFlow(GatewayUsageSummary(updatedAtMs = null, providers = emptyList()))
  val usageSummary: StateFlow<GatewayUsageSummary> = _usageSummary.asStateFlow()
  private val _usageRefreshing = MutableStateFlow(false)
  val usageRefreshing: StateFlow<Boolean> = _usageRefreshing.asStateFlow()
  private val _usageErrorText = MutableStateFlow<NativeText?>(null)
  val usageErrorText: StateFlow<String?> = _usageErrorText.resolveOptionalNativeText()
  private val _skillsSummary = MutableStateFlow(GatewaySkillsSummary(skills = emptyList()))
  val skillsSummary: StateFlow<GatewaySkillsSummary> = _skillsSummary.asStateFlow()
  private val _skillsRefreshing = MutableStateFlow(false)
  val skillsRefreshing: StateFlow<Boolean> = _skillsRefreshing.asStateFlow()
  private val _skillsErrorText = MutableStateFlow<NativeText?>(null)
  val skillsErrorText: StateFlow<String?> = _skillsErrorText.resolveOptionalNativeText()
  private val _clawHubSkillMethodsAvailable = MutableStateFlow(false)
  val clawHubSkillMethodsAvailable: StateFlow<Boolean> = _clawHubSkillMethodsAvailable.asStateFlow()
  private val _skillMutationKeys = MutableStateFlow<Set<String>>(emptySet())
  val skillMutationKeys: StateFlow<Set<String>> = _skillMutationKeys.asStateFlow()
  private val _clawHubSkillSearchState = MutableStateFlow(GatewayClawHubSkillSearchState())
  val clawHubSkillSearchState: StateFlow<GatewayClawHubSkillSearchState> =
    _clawHubSkillSearchState.asStateFlow()
  private val clawHubSkillSearchSeq = AtomicLong(0)
  private val clawHubSkillReviewSeq = AtomicLong(0)
  private val clawHubSkillInstallMutex = Mutex()
  private val _skillWorkshopSummary = MutableStateFlow(GatewaySkillWorkshopSummary(proposals = emptyList()))
  val skillWorkshopSummary: StateFlow<GatewaySkillWorkshopSummary> = _skillWorkshopSummary.asStateFlow()
  private val _skillWorkshopRefreshing = MutableStateFlow(false)
  val skillWorkshopRefreshing: StateFlow<Boolean> = _skillWorkshopRefreshing.asStateFlow()
  private val _skillWorkshopErrorText = MutableStateFlow<NativeText?>(null)
  val skillWorkshopErrorText: StateFlow<String?> = _skillWorkshopErrorText.resolveOptionalNativeText()
  private val _skillWorkshopNoticeText = MutableStateFlow<NativeText?>(null)
  val skillWorkshopNoticeText: StateFlow<String?> = _skillWorkshopNoticeText.resolveOptionalNativeText()
  private val _skillWorkshopInspectingProposalId = MutableStateFlow<String?>(null)
  val skillWorkshopInspectingProposalId: StateFlow<String?> = _skillWorkshopInspectingProposalId.asStateFlow()
  private val _skillWorkshopMutatingProposalId = MutableStateFlow<String?>(null)
  val skillWorkshopMutatingProposalId: StateFlow<String?> = _skillWorkshopMutatingProposalId.asStateFlow()
  private val skillWorkshopListSeq = AtomicLong(0)
  private val skillWorkshopInspectSeq = AtomicLong(0)
  private val skillWorkshopMutationSeq = AtomicLong(0)
  private val _nodesDevicesSummary =
    MutableStateFlow(
      GatewayNodesDevicesSummary(
        nodes = emptyList(),
        pendingDevices = emptyList(),
        pairedDevices = emptyList(),
      ),
    )
  val nodesDevicesSummary: StateFlow<GatewayNodesDevicesSummary> = _nodesDevicesSummary.asStateFlow()
  private val _nodesDevicesRefreshing = MutableStateFlow(false)
  val nodesDevicesRefreshing: StateFlow<Boolean> = _nodesDevicesRefreshing.asStateFlow()
  private val _nodesDevicesErrorText = MutableStateFlow<NativeText?>(null)
  val nodesDevicesErrorText: StateFlow<String?> = _nodesDevicesErrorText.resolveOptionalNativeText()
  private val _nodesDevicesNoticeText = MutableStateFlow<NativeText?>(null)
  val nodesDevicesNoticeText: StateFlow<String?> = _nodesDevicesNoticeText.resolveOptionalNativeText()
  private val _devicePairingCapabilities = MutableStateFlow(GatewayDevicePairingCapabilities())
  val devicePairingCapabilities: StateFlow<GatewayDevicePairingCapabilities> =
    _devicePairingCapabilities.asStateFlow()
  private val _devicePairingMutation = MutableStateFlow<GatewayDevicePairingMutation?>(null)
  val devicePairingMutation: StateFlow<GatewayDevicePairingMutation?> = _devicePairingMutation.asStateFlow()
  private val devicePairingMutationLock = Any()
  private val nodeApprovalRefreshGuard = LatestGatewayRefreshGuard()
  private val _execApprovals = MutableStateFlow<List<GatewayExecApprovalSummary>>(emptyList())
  val execApprovals: StateFlow<List<GatewayExecApprovalSummary>> = _execApprovals.asStateFlow()
  private val _execApprovalsRefreshing = MutableStateFlow(false)
  val execApprovalsRefreshing: StateFlow<Boolean> = _execApprovalsRefreshing.asStateFlow()
  private val _execApprovalsErrorText = MutableStateFlow<String?>(null)
  val execApprovalsErrorText: StateFlow<String?> = _execApprovalsErrorText.asStateFlow()
  private val _execApprovalsNotice = MutableStateFlow<GatewayExecApprovalNotice?>(null)
  val execApprovalsNotice: StateFlow<GatewayExecApprovalNotice?> = _execApprovalsNotice.asStateFlow()
  private val execApprovalsRefreshSeq = AtomicLong(0)
  private val execApprovalsStateLock = Any()
  private val resolvedExecApprovalIds = Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())
  private val pendingExecApprovalWrites = mutableMapOf<String, PendingExecApprovalWrite>()

  // Each hello pins one approval RPC family. The epoch prevents an old socket's
  // response from publishing into a replacement socket on the same stable endpoint.
  private val gatewayMethodsLock = Any()
  private var gatewayApprovalRpcFamily = GatewayApprovalRpcFamily.Unavailable
  private var gatewayMethodsEpoch = 0L

  @Volatile internal var gatewayDataRequestOverrideForTests: GatewayDataRequestOverride? = null

  @Volatile internal var gatewayDataRequestTimeoutObserverForTests: ((method: String, timeoutMs: Long) -> Unit)? = null

  @Volatile internal var clawHubSkillInstallBeforeClaimObserverForTests: (() -> Unit)? = null
  private val _channelsSummary = MutableStateFlow(GatewayChannelsSummary(channels = emptyList()))
  val channelsSummary: StateFlow<GatewayChannelsSummary> = _channelsSummary.asStateFlow()
  private val _channelsRefreshing = MutableStateFlow(false)
  val channelsRefreshing: StateFlow<Boolean> = _channelsRefreshing.asStateFlow()
  private val _channelsErrorText = MutableStateFlow<NativeText?>(null)
  val channelsErrorText: StateFlow<String?> = _channelsErrorText.resolveOptionalNativeText()
  private val _dreamingSummary = MutableStateFlow(GatewayDreamingSummary())
  val dreamingSummary: StateFlow<GatewayDreamingSummary> = _dreamingSummary.asStateFlow()
  private val _dreamingRefreshing = MutableStateFlow(false)
  val dreamingRefreshing: StateFlow<Boolean> = _dreamingRefreshing.asStateFlow()
  private val _dreamingErrorText = MutableStateFlow<NativeText?>(null)
  val dreamingErrorText: StateFlow<String?> = _dreamingErrorText.resolveOptionalNativeText()
  private val _healthLogsSummary = MutableStateFlow(GatewayHealthLogsSummary())
  val healthLogsSummary: StateFlow<GatewayHealthLogsSummary> = _healthLogsSummary.asStateFlow()
  private val _healthLogsRefreshing = MutableStateFlow(false)
  val healthLogsRefreshing: StateFlow<Boolean> = _healthLogsRefreshing.asStateFlow()
  private val _healthLogsErrorText = MutableStateFlow<NativeText?>(null)
  val healthLogsErrorText: StateFlow<String?> = _healthLogsErrorText.resolveOptionalNativeText()

  private val _isForeground = MutableStateFlow(initialForeground)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private data class TalkPttOwnership(
    val captureId: String,
    val epoch: Long,
  )

  private data class VoiceWakeSuppressionUpdate(
    val reason: VoiceWakeSuppressionReason,
    val suppressed: Boolean,
    val revision: Long,
  )

  private val voiceLifecycleEpoch = AtomicLong()
  private val voiceCaptureOwnershipEpoch = AtomicLong()
  private val talkPttCommandEpoch = AtomicLong()
  private val talkPttOwnership = AtomicReference<TalkPttOwnership?>()

  // Keep ownership epochs and their service/capture state transitions atomic.
  // Otherwise stale PTT cleanup can pass its epoch check before a UI mode change.
  private val voiceCaptureOwnershipLock = Any()
  private var voiceWakeSuppressionRevision = 0L
  private var voiceNoteOwnsMic = false
  private var dictationOwnsMic = false
  private var cameraAudioOwnsMic = false
  private val voiceReplySpeechDepth = AtomicInteger(0)
  private val voiceCapturePreparationMutex = Mutex()

  private var didAutoRequestCanvasRehydrate = false
  private val canvasRehydrateSeq = AtomicLong(0)

  @Volatile private var nodePresenceAliveLastSuccessAtMs: Long? = null
  private var operatorConnected = false
  private var operatorStatusText: String = "Offline"
  private var nodeStatusText: String = "Offline"
  private var operatorConnectionProblem: GatewayConnectionProblem? = null
  private var nodeConnectionProblem: GatewayConnectionProblem? = null
  private val gatewayStatusLock = Any()

  private val operatorSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { hello ->
        recordConnectedGateway()
        _serverName.value = hello.serverName
        _remoteAddress.value = hello.remoteAddress
        _gatewayVersion.value = hello.serverVersion
        _gatewayUpdateAvailable.value = hello.updateAvailable
        replaceGatewayMethods(hello.methods)
        val operatorScopes = normalizeOperatorScopes(hello.authScopes)
        _operatorScopes.value = operatorScopes
        _devicePairingCapabilities.value =
          selectGatewayDevicePairingCapabilities(hello.methods, operatorScopes)
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        val mainSessionKey =
          prepareMainSessionKey(resolveAgentIdFromMainSessionKey(hello.mainSessionKey))
        // Create/adopt before history refresh; this keeps the first connected read on the
        // device-owned session without changing the shipped key or its existing transcript.
        chat.onGatewayConnected(mainSessionBinding(mainSessionKey))
        refreshGatewayControlPage()
        updateStatus {
          operatorConnectionProblem = null
          operatorConnected = true
          operatorStatusText = "Connected"
        }
        micCapture.onGatewayConnectionChanged(true)
        wearProxyBridge()?.publishConnection(connected = true, status = "Connected")
        scope.launch {
          subscribeOperatorSessionEvents()
          refreshWakeWordsFromGateway()
          refreshExecApprovalsFromGateway()
          refreshHomeCanvasOverviewIfConnected()
          if (voiceReplySpeakerLazy.isInitialized()) {
            voiceReplySpeaker.refreshConfig()
          }
        }
      },
      onDisconnected = { message ->
        if (wearRealtimeTalkControllerLazy.isInitialized()) wearRealtimeTalkController.abort()
        clearOperatorGatewayState(retirePendingCronRuns = false)
        chat.applyMainSessionKey(resolveMainSessionKey())
        chat.onDisconnected(message)
        updateStatus {
          operatorConnected = false
          operatorStatusText = message
          operatorConnectionProblem = gatewayProblemAfterDisconnect(operatorConnectionProblem, message)
        }
        micCapture.onGatewayConnectionChanged(false)
        wearProxyBridge()?.publishConnection(connected = false, status = message)
      },
      onConnectFailure = { error, pauseReconnect ->
        if (wearRealtimeTalkControllerLazy.isInitialized()) wearRealtimeTalkController.abort()
        val problem = gatewayConnectionProblem(error, pauseReconnect)
        updateStatus {
          operatorConnected = false
          operatorStatusText = problem.message
          operatorConnectionProblem = problem
        }
        micCapture.onGatewayConnectionChanged(false)
        wearProxyBridge()?.publishConnection(connected = false, status = problem.message)
      },
      onEvent = { event, payloadJson ->
        handleGatewayEvent(event, payloadJson)
      },
      customHeadersProvider = prefs::loadGatewayCustomHeaders,
    )

  private data class SecondaryOperatorRuntime(
    val endpoint: GatewayEndpoint,
    val session: GatewaySession,
  )

  private val secondaryOperatorSessions = ConcurrentHashMap<String, SecondaryOperatorRuntime>()
  private val _backgroundGatewayStatuses = MutableStateFlow<Map<String, String>>(emptyMap())
  val backgroundGatewayStatuses: StateFlow<Map<String, String>> = _backgroundGatewayStatuses.asStateFlow()

  private val wearProxyController by lazy {
    WearProxyController(
      requestGateway = ::requestWearGateway,
      isGatewayConnected = operatorSession::isReady,
      gatewayStatusText = { synchronized(gatewayStatusLock) { operatorStatusText } },
      activeAgentId = {
        resolveAgentIdFromMainSessionKey(mainSessionKey.value) ?: gatewayDefaultAgentId.value
      },
      activeSessionKey = { chatSessionKey.value },
      selectedModelRef = { chatSelectedModelRef.value },
      agents = {
        gatewayAgents.value.map { agent ->
          WearProxyAgent(
            id = agent.id,
            name = agent.name,
            emoji = agent.emoji,
          )
        }
      },
      selectGatewayAgent = { agentId ->
        if (gatewayAgents.value.none { agent -> agent.id == agentId }) {
          false
        } else {
          selectChatAgent(agentId)
          true
        }
      },
      models = {
        chatModelCatalog.value
          .asSequence()
          .filter { model -> model.available != false }
          .map { model ->
            val provider = model.provider.trim()
            val ref =
              if (provider.isEmpty() || model.id.startsWith("$provider/")) {
                model.id
              } else {
                "$provider/${model.id}"
              }
            WearProxyModel(ref = ref, name = model.name)
          }.toList()
      },
      selectSessionModel = { sessionKey, modelRef ->
        chat.setSessionModelAwait(sessionKey = sessionKey, modelRef = modelRef)
      },
      connectGateway = { refreshGatewayConnection() },
      disconnectGateway = { disconnect() },
      startRealtimeTalk = { nodeId, sessionKey, attemptId, language ->
        if (startWearRealtimeTalk(nodeId, sessionKey, attemptId, language)) wearRealtimeTalkSnapshot.value else null
      },
      stopRealtimeTalk = { nodeId, attemptId ->
        if (stopWearRealtimeTalk(nodeId, attemptId)) wearRealtimeTalkSnapshot.value else null
      },
    )
  }

  internal suspend fun handleWearProxyRequest(
    sourceNodeId: String,
    request: WearMessage.Request,
  ): WearMessage.Response = wearProxyController.handle(request, sourceNodeId)

  private suspend fun requestWearGateway(
    method: String,
    params: JsonObject,
  ): JsonElement {
    val lease =
      operatorSession.captureRequestLease()
        ?: throw WearProxyGatewayException("unavailable", "Phone gateway is offline")
    val response =
      try {
        lease.request(method, params.toString())
      } catch (err: GatewayRequestRejected) {
        throw WearProxyGatewayException(err.gatewayError.code, err.gatewayError.message)
      } catch (_: GatewayRequestNotEnqueued) {
        throw WearProxyGatewayException("unavailable", "Phone gateway is offline")
      } catch (_: GatewayRequestOutcomeUnknown) {
        throw WearProxyGatewayException("unavailable", "Phone gateway request outcome is unknown")
      }
    return try {
      json.parseToJsonElement(response)
    } catch (_: Throwable) {
      throw WearProxyGatewayException("invalid_response", "$method returned invalid JSON")
    }
  }

  private fun wearProxyBridge(): WearProxyBridge? = (appContext as? NodeApp)?.wearProxyBridge

  private fun clearOperatorGatewayState(retirePendingCronRuns: Boolean) {
    invalidateNodeCapabilityApprovalState()
    _serverName.value = null
    _remoteAddress.value = null
    _gatewayVersion.value = null
    _gatewayUpdateAvailable.value = null
    replaceGatewayMethods(emptySet())
    _operatorScopes.value = emptyList()
    _devicePairingCapabilities.value = GatewayDevicePairingCapabilities()
    _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
    _gatewayAgents.value = emptyList()
    selectedChatAgentId = null
    _modelCatalog.value = emptyList()
    providerModelCatalogRefreshGuard.invalidate()
    _providerModelCatalog.value = emptyList()
    _providerModelCatalogRefreshing.value = false
    _providerModelCatalogErrorText.value = null
    _modelAuthProviders.value = emptyList()
    _modelCatalogRefreshing.value = false
    _modelCatalogErrorText.value = null
    _talkSetupReadiness.value = GatewayTalkSetupReadiness.unverified()
    voiceWakeWordsSaveSeq.incrementAndGet()
    _voiceWakeWordsSaving.value = false
    _voiceWakeWordsNoticeText.value = null
    cronRefreshGuard.invalidate()
    _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
    _cronJobs.value = emptyList()
    _cronRefreshing.value = false
    _cronErrorText.value = null
    cronJobDetailRequestGuard.cancel { _cronJobDetailState.value = GatewayCronJobDetailState.Idle }
    cronRunHistoryRequestGuard.cancel { _cronRunHistoryState.value = GatewayCronRunHistoryState.Idle }
    _cronActionState.value = GatewayCronActionState.Idle
    if (retirePendingCronRuns) {
      pendingCronRunRegistry.clear { _pendingCronRunJobIds.value = it }
    }
    _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
    _usageRefreshing.value = false
    _usageErrorText.value = null
    _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
    _skillsRefreshing.value = false
    _skillsErrorText.value = null
    _skillMutationKeys.value = emptySet()
    clawHubSkillSearchSeq.incrementAndGet()
    clawHubSkillReviewSeq.incrementAndGet()
    _clawHubSkillSearchState.value = GatewayClawHubSkillSearchState()
    _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(proposals = emptyList())
    _skillWorkshopRefreshing.value = false
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
    _skillWorkshopInspectingProposalId.value = null
    _skillWorkshopMutatingProposalId.value = null
    skillWorkshopListSeq.incrementAndGet()
    skillWorkshopInspectSeq.incrementAndGet()
    skillWorkshopMutationSeq.incrementAndGet()
    _nodesDevicesSummary.value =
      GatewayNodesDevicesSummary(
        nodes = emptyList(),
        pendingDevices = emptyList(),
        pairedDevices = emptyList(),
      )
    _nodesDevicesRefreshing.value = false
    _nodesDevicesErrorText.value = null
    _nodesDevicesNoticeText.value = null
    synchronized(devicePairingMutationLock) {
      _devicePairingMutation.value = null
    }
    invalidateExecApprovalRefreshes()
    resolvedExecApprovalIds.clear()
    if (retirePendingCronRuns) {
      synchronized(execApprovalsStateLock) { pendingExecApprovalWrites.clear() }
    }
    _execApprovals.value = emptyList()
    _execApprovalsRefreshing.value = false
    _execApprovalsErrorText.value = null
    _execApprovalsNotice.value = null
    _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
    _channelsRefreshing.value = false
    _channelsErrorText.value = null
    _dreamingSummary.value = GatewayDreamingSummary()
    _dreamingRefreshing.value = false
    _dreamingErrorText.value = null
    _healthLogsSummary.value = GatewayHealthLogsSummary()
    _healthLogsRefreshing.value = false
    _healthLogsErrorText.value = null
  }

  private suspend fun subscribeOperatorSessionEvents() {
    try {
      operatorSession.request("sessions.subscribe", null)
    } catch (err: Throwable) {
      Log.d("OpenClawRuntime", "sessions.subscribe failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private val nodeSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = {
        recordConnectedGateway()
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus {
          nodeConnectionProblem = null
          _nodeConnected.value = true
          nodeStatusText = "Connected"
        }
        notificationOutbox.onConnected()
        showLocalCanvasOnConnect()
        publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Connect)
        val endpoint = connectedEndpoint
        val auth = activeGatewayAuth
        if (operatorConnected) {
          scope.launch { refreshNodesDevicesFromGateway() }
        } else if (endpoint != null && auth != null) {
          maybeStartOperatorSessionAfterNodeConnect(endpoint, auth)
        }
      },
      onDisconnected = { message ->
        invalidateNodeCapabilityApprovalState()
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus {
          _nodeConnected.value = false
          nodeStatusText = message
          nodeConnectionProblem = gatewayProblemAfterDisconnect(nodeConnectionProblem, message)
        }
        showLocalCanvasOnDisconnect()
      },
      onConnectFailure = { error, pauseReconnect ->
        updateStatus {
          nodeConnectionProblem = gatewayConnectionProblem(error, pauseReconnect)
        }
        if (operatorConnected && nodeConnectFailureNeedsApprovalRefresh(error)) {
          scope.launch { refreshNodesDevicesFromGateway() }
        }
      },
      onEvent = ::handleNodeGatewayEvent,
      onInvoke = { req ->
        invokeDispatcher.handleInvoke(req.command, req.paramsJson)
      },
      onTlsFingerprint = { stableId, fingerprint ->
        prefs.saveGatewayTlsFingerprint(stableId, fingerprint)
      },
      customHeadersProvider = prefs::loadGatewayCustomHeaders,
    )

  /**
   * Triggers an immediate gateway reconnect when Android reports a validated transport
   * restore, instead of waiting for the time-based backoff slot in [GatewaySession].
   * Each session keeps ownership of desired-connection and auth-pause decisions.
   */
  private val networkMonitor = NetworkMonitor(appContext, ::retryGatewaySessionsAfterNetworkRestore)

  private fun retryGatewaySessionsAfterNetworkRestore() {
    launchGatewayLifecycle {
      operatorSession.retryAfterNetworkRestore()
      nodeSession.retryAfterNetworkRestore()
    }
  }

  private val notificationOutbox: NotificationNodeEventOutbox by lazy {
    NotificationNodeEventOutbox(
      isAuthorized = ::isNotificationEventStillAuthorized,
      isConnected = nodeSession::isReady,
      deliveryIntervalMs = ::notificationDeliveryIntervalMs,
      invalidateConnection = nodeSession::reconnect,
      send = { pending ->
        nodeSession.sendNodeEventWithOutcomeForEndpoint(
          expectedEndpointStableId = pending.gatewayId,
          event = pending.event,
          payloadJson = pending.payloadJson,
        )
      },
    )
  }

  private fun notificationDeliveryIntervalMs(): Long {
    val maxEvents =
      prefs.notificationForwardingMaxEventsPerMinute.value
        .coerceAtLeast(1)
        .toLong()
    return (60_000L + maxEvents - 1L) / maxEvents
  }

  private fun isNotificationEventStillAuthorized(event: PendingNotificationNodeEvent): Boolean {
    if (event.event != "notifications.changed") return false
    if (!DeviceNotificationListenerService.isAccessEnabled(appContext)) return false
    val payload =
      runCatching { event.payloadJson?.let(json::parseToJsonElement).asObjectOrNull() }
        .getOrNull()
        ?: return false
    val packageName = payload["packageName"].asStringOrNull()?.trim().orEmpty()
    if (packageName.isEmpty()) return false
    val policy = prefs.getNotificationForwardingPolicy(appPackageName = appContext.packageName)
    if (event.gatewayId != null && event.gatewayId != prefs.gatewayRegistry.activeStableId.value) return false
    val eventSessionKey = payload["sessionKey"].asStringOrNull()?.trim()?.ifEmpty { null }
    return policy.enabled &&
      policy.sessionKey == eventSessionKey &&
      policy.allowsPackage(packageName) &&
      !policy.isWithinQuietHours(nowEpochMs = System.currentTimeMillis())
  }

  init {
    if (mode == NodeRuntimeMode.Live) {
      scope.launch { notificationOutbox.deliver() }
      DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
        notificationOutbox.enqueue(
          PendingNotificationNodeEvent(
            event = event,
            payloadJson = payloadJson,
            gatewayId = prefs.gatewayRegistry.activeStableId.value,
          ),
        )
      }
    }
  }

  private val chatSessionDeletionListenerSequence = AtomicLong()
  private val chatSessionDeletionListeners = ConcurrentHashMap<Long, (ChatSessionDeletion) -> Unit>()

  internal fun addChatSessionDeletionListener(listener: (ChatSessionDeletion) -> Unit): () -> Unit {
    val id = chatSessionDeletionListenerSequence.incrementAndGet()
    chatSessionDeletionListeners[id] = listener
    return { chatSessionDeletionListeners.remove(id) }
  }

  private fun publishChatSessionDeletion(deletion: ChatSessionDeletion) {
    chatSessionDeletionListeners.values.forEach { listener -> listener(deletion) }
  }

  private val chat: ChatController =
    when (mode) {
      NodeRuntimeMode.Live ->
        ChatController(
          scope = scope,
          session = operatorSession,
          json = json,
          transcriptCache = chatTranscriptCache,
          cacheScope = ::chatCacheScope,
          currentDefaultAgentId = { gatewayDefaultAgentId.value },
          currentDefaultAgentRevision = gatewayDefaultAgentRevision::get,
          commandOutbox = chatCommandOutbox,
          recordModelRecent = prefs::recordModelRecent,
          onSessionDeleted = ::publishChatSessionDeletion,
          onOfflineDefaultAgentRestored = ::syncMainSessionKey,
        )
      NodeRuntimeMode.ScreenshotFixture ->
        ChatController(
          scope = scope,
          json = json,
          requestGateway = AndroidScreenshotFixture::request,
        )
    }.also {
      it.applyMainSessionKey(_mainSessionKey.value)
    }

  private val messageSpeechControllerLazy =
    lazy {
      MessageSpeechController(
        scope = scope,
        synthesizer = MessageSpeechClient(session = operatorSession, json = json),
        player = TalkAudioPlayer(appContext),
        localSpeech = SystemSpeechSpeaker(appContext),
      ).also { controller ->
        scope.launch {
          controller.state.collect { state ->
            voiceWakeManager.setSuppressed(VoiceWakeSuppressionReason.MessageSpeech, state != null)
          }
        }
      }
    }
  private val messageSpeechController: MessageSpeechController
    get() = messageSpeechControllerLazy.value
  internal val messageSpeechState: StateFlow<MessageSpeechState?>
    get() = messageSpeechController.state

  /**
   * Stable per-gateway scope for the offline chat cache; resolved per call so cached transcripts
   * never leak across gateways. Null (nothing paired/configured) disables cache reads and writes.
   */
  private fun chatCacheGatewayId(): String? {
    connectedEndpoint?.stableId?.let { return it }
    return prefs.gatewayRegistry.activeStableId.value
  }

  private fun chatCacheScope(): ChatCacheScope? =
    chatCacheGatewayId()?.let { gatewayId ->
      ChatCacheScope(gatewayId = gatewayId, connectionGeneration = connectAttemptSeq.get())
    }

  private val voiceReplySpeakerLazy: Lazy<TalkModeManager> =
    lazy {
      // Reuse the existing TalkMode speech engine for native Android TTS playback
      // without enabling the legacy talk capture loop.
      TalkModeManager(
        context = appContext,
        scope = scope,
        session = operatorSession,
        isConnected = { gatewayConnectionDisplay.value.isConnected },
        gatewayStableId = { connectedEndpoint?.stableId },
        onBeforeSpeak = {
          acquireVoiceReplySpeechSuppression()
          micCapture.pauseForTts()
        },
        onAfterSpeak = {
          try {
            micCapture.resumeAfterTts()
          } finally {
            releaseVoiceReplySpeechSuppression()
          }
        },
      ).also { speaker ->
        speaker.setPlaybackEnabled(prefs.speakerEnabled.value)
      }
    }
  private val voiceReplySpeaker: TalkModeManager
    get() = voiceReplySpeakerLazy.value

  private val micCapture: MicCaptureManager by lazy {
    MicCaptureManager(
      context = appContext,
      scope = scope,
      preferredAudioInputDevice = { prefs.preferredAudioInputDevice.value },
      onAppliedAudioInputChanged = { key ->
        if (_voiceCaptureMode.value == VoiceCaptureMode.ManualMic) {
          _activeAudioInputDevicePreference.value = key
        }
      },
      createTranscriptionSession = {
        val gatewayId = connectedEndpoint?.stableId ?: error("not connected")
        val params =
          buildJsonObject {
            put("mode", JsonPrimitive("transcription"))
            put("transport", JsonPrimitive("gateway-relay"))
            put("brain", JsonPrimitive("none"))
          }
        val response =
          operatorSession.requestForEndpoint(
            gatewayId,
            "talk.session.create",
            params.toString(),
            timeoutMs = 15_000,
          )
        GatewayTranscriptionSession(
          id = parseTalkSessionId(response),
          gatewayId = gatewayId,
        )
      },
      appendTranscriptionAudio = { session, audio, onError ->
        val params =
          buildJsonObject {
            put("sessionId", JsonPrimitive(session.id))
            put("audioBase64", JsonPrimitive(Base64.encodeToString(audio, Base64.NO_WRAP)))
            put("timestamp", JsonPrimitive(SystemClock.elapsedRealtime()))
          }
        operatorSession.sendRequestFrameForEndpoint(
          session.gatewayId,
          "talk.session.appendAudio",
          params.toString(),
          timeoutMs = 8_000,
        ) { error -> onError(error.message) }
      },
      closeTranscriptionSession = { session ->
        val params = buildJsonObject { put("sessionId", JsonPrimitive(session.id)) }
        operatorSession.requestForEndpoint(
          session.gatewayId,
          "talk.session.close",
          params.toString(),
          timeoutMs = 5_000,
        )
      },
      sendToGateway = { message, onRunIdKnown ->
        val gatewayId = connectedEndpoint?.stableId ?: error("not connected")
        val idempotencyKey = UUID.randomUUID().toString()
        // Notify MicCaptureManager of the idempotency key *before* the network
        // call so pendingRunId is set before any chat events can arrive.
        onRunIdKnown(idempotencyKey)
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(resolveMainSessionKey()))
            put("message", JsonPrimitive(message))
            put("thinking", JsonPrimitive(chatThinkingLevel.value))
            put("timeoutMs", JsonPrimitive(30_000))
            put("idempotencyKey", JsonPrimitive(idempotencyKey))
          }
        val response = operatorSession.requestForEndpoint(gatewayId, "chat.send", params.toString())
        val ack = parseChatSendAck(json, response)
        ack.copy(runId = ack.runId ?: idempotencyKey)
      },
      refreshAfterTerminalSuccess = {
        chat.refresh()
      },
      speakAssistantReply = { text ->
        // Voice-tab replies should speak through the dedicated reply speaker.
        // Relying on talkMode.ttsOnAllResponses here can drop playback if the
        // chat-event path misses the terminal event for this turn.
        voiceReplySpeaker.speakAssistantReply(text)
      },
    )
  }

  val micStatusText: StateFlow<String>
    get() = micCapture.statusText

  val micLiveTranscript: StateFlow<String?>
    get() = micCapture.liveTranscript

  val micIsListening: StateFlow<Boolean>
    get() = micCapture.isListening

  val micEnabled: StateFlow<Boolean>
    get() = micCapture.micEnabled

  val micCooldown: StateFlow<Boolean>
    get() = micCapture.micCooldown

  val micQueuedMessages: StateFlow<List<String>>
    get() = micCapture.queuedMessages

  val micConversation: StateFlow<List<VoiceConversationEntry>>
    get() = micCapture.conversation

  val micInputLevel: StateFlow<Float>
    get() = micCapture.inputLevel

  val micIsSending: StateFlow<Boolean>
    get() = micCapture.isSending

  private val talkMode: TalkModeManager by lazy {
    TalkModeManager(
      context = appContext,
      scope = scope,
      session = operatorSession,
      isConnected = { gatewayConnectionDisplay.value.isConnected },
      gatewayStableId = { connectedEndpoint?.stableId },
      preferredAudioInputDevice = { prefs.preferredAudioInputDevice.value },
      onAppliedAudioInputChanged = { key ->
        if (_voiceCaptureMode.value == VoiceCaptureMode.TalkMode) {
          _activeAudioInputDevicePreference.value = key
        }
      },
      onBeforeSpeak = { micCapture.pauseForTts() },
      onAfterSpeak = { micCapture.resumeAfterTts() },
      onStoppedByRelay = { finishTalkModeAfterRelayClose() },
    )
  }

  val talkModeEnabled: StateFlow<Boolean>
    get() = talkMode.isEnabled

  val talkModeListening: StateFlow<Boolean>
    get() = talkMode.isListening

  val talkModeSpeaking: StateFlow<Boolean>
    get() = talkMode.isSpeaking

  val talkInputLevel: StateFlow<Float>
    get() = talkMode.inputLevel

  val talkOutputLevel: StateFlow<Float?>
    get() = talkMode.outputLevel

  val talkSpeechActive: StateFlow<Boolean>
    get() = talkMode.speechActive

  val talkAwaitingAgent: StateFlow<Boolean>
    get() = talkMode.awaitingAgent

  val talkModeStatusText: StateFlow<String>
    get() = talkMode.statusText

  val talkModeConversation: StateFlow<List<VoiceConversationEntry>>
    get() = talkMode.conversation

  private val wearRealtimeTalkControllerLazy: Lazy<WearRealtimeTalkController> =
    lazy {
      WearRealtimeTalkController(
        scope = scope,
        isConnected = { gatewayConnectionDisplay.value.isConnected },
        requestGateway = { method, paramsJson, timeoutMs ->
          val gatewayId = connectedEndpoint?.stableId ?: error("Gateway not connected")
          operatorSession.requestForEndpoint(gatewayId, method, paramsJson, timeoutMs)
        },
        sendGatewayFrame = { method, paramsJson, timeoutMs, onError ->
          val gatewayId = connectedEndpoint?.stableId ?: error("Gateway not connected")
          operatorSession.sendRequestFrameForEndpoint(gatewayId, method, paramsJson, timeoutMs) { error ->
            onError(error.message)
          }
        },
        sendWatchFrame = { nodeId, type, payload ->
          val app = appContext as? NodeApp ?: error("Wear channel owner is unavailable")
          app.wearRealtimeChannels.send(nodeId, type, payload)
        },
        onSnapshot = { snapshot ->
          wearProxyBridge()?.publishTalk(WearRealtimeTalkCodec.encode(snapshot))
        },
        onForceCloseWatchChannel = { nodeId ->
          scope.launch { (appContext as? NodeApp)?.wearRealtimeChannels?.close(nodeId) }
        },
      )
    }

  private val wearRealtimeTalkController: WearRealtimeTalkController
    get() = wearRealtimeTalkControllerLazy.value

  internal val wearRealtimeTalkSnapshot: StateFlow<WearRealtimeTalkSnapshot>
    get() = wearRealtimeTalkController.snapshot

  internal suspend fun startWearRealtimeTalk(
    nodeId: String,
    sessionKey: String,
    attemptId: String,
    language: String?,
  ): Boolean {
    if (talkModeEnabled.value || micEnabled.value || micCooldown.value) return false
    val resolvedLanguage = talkMode.resolveRealtimeLanguageHint(language)
    return wearRealtimeTalkController.start(nodeId, sessionKey, attemptId, resolvedLanguage)
  }

  internal suspend fun stopWearRealtimeTalk(
    nodeId: String? = null,
    attemptId: String? = null,
  ): Boolean {
    // The watch closes its channel after receiving the stop response. Closing
    // here races the response and makes a normal stop look like link failure.
    return wearRealtimeTalkController.stop(nodeId, attemptId)
  }

  internal fun appendWearRealtimeAudio(
    nodeId: String,
    payload: ByteArray,
  ) {
    if (wearRealtimeTalkControllerLazy.isInitialized()) {
      wearRealtimeTalkController.appendAudio(nodeId, payload)
    }
  }

  private fun syncMainSessionKey(agentId: String?) {
    val resolvedKey = resolveNodeMainSessionKey(agentId)
    talkMode.setMainSessionKey(resolvedKey)
    if (_mainSessionKey.value == resolvedKey) return
    _mainSessionKey.value = resolvedKey
    if (operatorConnected) {
      chat.prepareMainSessionKey(resolvedKey)
      chat.onGatewayConnected(mainSessionBinding(resolvedKey))
    } else {
      chat.applyMainSessionKey(resolvedKey)
    }
    updateHomeCanvasState()
  }

  private fun prepareMainSessionKey(agentId: String?): String {
    val resolvedKey = resolveNodeMainSessionKey(agentId)
    // Always push into TalkMode so a lazy instance cannot retain the "main" alias.
    talkMode.setMainSessionKey(resolvedKey)
    if (_mainSessionKey.value != resolvedKey) {
      _mainSessionKey.value = resolvedKey
      updateHomeCanvasState()
    }
    chat.prepareMainSessionKey(resolvedKey)
    return resolvedKey
  }

  private fun selectMainSessionKey(agentId: String) {
    val resolvedKey = resolveNodeMainSessionKey(agentId)
    talkMode.setMainSessionKey(resolvedKey)
    _mainSessionKey.value = resolvedKey
    chat.prepareAndSelectMainSessionKey(resolvedKey)
    chat.onGatewayConnected(mainSessionBinding(resolvedKey))
    updateHomeCanvasState()
  }

  private fun mainSessionBinding(sessionKey: String): MainSessionBinding =
    MainSessionBinding(
      key = sessionKey,
      label = buildAndroidAppSessionLabel(prefs.displayName.value, identityStore.loadOrCreate().deviceId),
    )

  private fun updateStatus(update: () -> Unit = {}) {
    synchronized(gatewayStatusLock) {
      update()
      // Select and publish text plus diagnostics atomically; operator and node callbacks run concurrently.
      val display =
        gatewayConnectionDisplay(
          operatorConnected = operatorConnected,
          nodeConnected = _nodeConnected.value,
          operatorStatusText = operatorStatusText,
          nodeStatusText = nodeStatusText,
          operatorProblem = operatorConnectionProblem,
          nodeProblem = nodeConnectionProblem,
        )
      _gatewayConnectionDisplay.value = display
      _isConnected.value = display.isConnected
      _statusText.value = display.statusText
      _gatewayConnectionProblem.value = display.problem
    }
    updateHomeCanvasState()
  }

  private fun setStandaloneGatewayStatus(statusText: String) {
    synchronized(gatewayStatusLock) {
      val display = GatewayConnectionDisplay(operatorConnected, statusText, null)
      _gatewayConnectionDisplay.value = display
      _isConnected.value = display.isConnected
      _statusText.value = display.statusText
      _gatewayConnectionProblem.value = display.problem
    }
    updateHomeCanvasState()
  }

  private fun gatewayConnectionProblem(
    error: GatewaySession.ErrorShape,
    pauseReconnect: Boolean,
  ): GatewayConnectionProblem {
    val details = error.details
    return GatewayConnectionProblem(
      code = details?.code ?: error.code,
      message = error.message,
      reason = details?.reason,
      requestId = details?.requestId,
      recommendedNextStep = details?.recommendedNextStep,
      pauseReconnect = pauseReconnect || details?.pauseReconnect == true,
      retryable = details?.retryable == true,
      clientMinProtocol = details?.clientMinProtocol,
      clientMaxProtocol = details?.clientMaxProtocol,
      expectedProtocol = details?.expectedProtocol,
      minimumProbeProtocol = details?.minimumProbeProtocol,
    )
  }

  private fun resolveMainSessionKey(): String {
    val trimmed = _mainSessionKey.value.trim()
    return if (trimmed.isEmpty()) "main" else trimmed
  }

  private fun showLocalCanvasOnConnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  private fun showLocalCanvasOnDisconnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!operatorConnected) {
      updateHomeCanvasState()
      return
    }
    scope.launch {
      refreshBrandingFromGateway()
      refreshAgentsFromGateway()
      refreshModelCatalogFromGateway()
      refreshProviderModelsFromGateway()
      refreshTalkSetupReadinessFromGateway()
      refreshCronFromGateway()
      refreshUsageFromGateway()
      refreshSkillsFromGateway()
      refreshNodesDevicesFromGateway()
      refreshChannelsFromGateway()
      refreshDreamingFromGateway()
      refreshHealthLogsFromGateway()
    }
  }

  fun refreshModelCatalog() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshModelCatalogFromGateway()
    }
  }

  fun refreshProviderModels() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshProviderModelsFromGateway()
    }
  }

  fun refreshTalkSetupReadiness() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch { refreshTalkSetupReadinessFromGateway() }
  }

  fun refreshAgents() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshAgentsFromGateway()
    }
  }

  fun refreshCronJobs() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshCronFromGateway()
    }
  }

  fun loadCronJobDetail(id: String) {
    val detailRequest = cronJobDetailRequestGuard.begin(id) ?: return
    val historyRequest = cronRunHistoryRequestGuard.begin(detailRequest.id) ?: return
    _cronJobDetailState.value = GatewayCronJobDetailState.Loading(detailRequest.id)
    _cronRunHistoryState.value = GatewayCronRunHistoryState.Loading(historyRequest.id)
    if (mode == NodeRuntimeMode.ScreenshotFixture) {
      applyScreenshotCronDetail(detailRequest = detailRequest, historyRequest = historyRequest)
      return
    }
    scope.launch { loadCronJobDetailFromGateway(detailRequest) }
    scope.launch { loadCronRunHistoryFromGateway(historyRequest) }
  }

  fun refreshCronRunHistory(id: String) {
    val request = cronRunHistoryRequestGuard.begin(id) ?: return
    _cronRunHistoryState.value = GatewayCronRunHistoryState.Loading(request.id)
    if (mode == NodeRuntimeMode.ScreenshotFixture) {
      publishScreenshotCronHistory(request)
      return
    }
    scope.launch { loadCronRunHistoryFromGateway(request) }
  }

  fun clearCronJobDetail() {
    cronJobDetailRequestGuard.cancel {
      _cronJobDetailState.value = GatewayCronJobDetailState.Idle
    }
    cronRunHistoryRequestGuard.cancel {
      _cronRunHistoryState.value = GatewayCronRunHistoryState.Idle
    }
  }

  fun dismissCronActionNotice(id: String) {
    val jobId = id.trim().takeIf { it.isNotEmpty() } ?: return
    val notice = _cronActionState.value as? GatewayCronActionState.Notice
    if (notice?.id == jobId) {
      _cronActionState.value = GatewayCronActionState.Idle
    }
  }

  fun runCronJob(id: String) {
    val jobId = id.trim().takeIf { it.isNotEmpty() } ?: return
    if (pendingCronRunRegistry.contains(jobId)) {
      _cronActionState.value =
        GatewayCronActionState.Notice(
          id = jobId,
          message = nativeText("This automation already has a queued run."),
          kind = GatewayCronNoticeKind.Warning,
        )
      return
    }
    launchCronAction(id = jobId, action = GatewayCronAction.Run) { gatewayScope, actionJobId ->
      val response =
        requestGatewayData(
          gatewayScope,
          "cron.run",
          buildJsonObject {
            put("id", JsonPrimitive(actionJobId))
            put("mode", JsonPrimitive("force"))
          }.toString(),
        )
      when (val outcome = parseGatewayCronRunOutcome(json.parseToJsonElement(response).asObjectOrNull())) {
        is GatewayCronRunOutcome.Started -> {
          outcome.runId?.let { runId ->
            var trackingStarted = false
            publishGatewayData(gatewayScope) {
              trackingStarted =
                pendingCronRunRegistry.begin(actionJobId, runId) {
                  _pendingCronRunJobIds.value = it
                }
            }
            if (trackingStarted) {
              trackQueuedCronRun(gatewayScope = gatewayScope, jobId = actionJobId, runId = runId)
            }
          }
          CronActionResult(
            message = if (outcome.runId == null) nativeText("Automation started.") else nativeText("Automation run queued."),
            kind = GatewayCronNoticeKind.Success,
            refresh = cronRunShouldRefresh(outcome),
          )
        }
        is GatewayCronRunOutcome.Skipped ->
          CronActionResult(
            message = outcome.reason.messageText,
            kind = GatewayCronNoticeKind.Warning,
            refresh = cronRunShouldRefresh(outcome),
          )
        GatewayCronRunOutcome.Rejected ->
          CronActionResult(
            message = nativeText("Gateway rejected the automation run."),
            kind = GatewayCronNoticeKind.Error,
            refresh = false,
          )
        null -> error("Gateway returned an invalid cron run result.")
      }
    }
  }

  fun setCronJobEnabled(
    id: String,
    enabled: Boolean,
  ) {
    launchCronAction(
      id = id,
      action = if (enabled) GatewayCronAction.Enable else GatewayCronAction.Disable,
    ) { gatewayScope, jobId ->
      requestGatewayData(
        gatewayScope,
        "cron.update",
        buildJsonObject {
          put("id", JsonPrimitive(jobId))
          put(
            "patch",
            buildJsonObject {
              put("enabled", JsonPrimitive(enabled))
            },
          )
        }.toString(),
      )
      CronActionResult(
        message = if (enabled) nativeText("Automation enabled.") else nativeText("Automation paused."),
        kind = GatewayCronNoticeKind.Success,
        refresh = true,
      )
    }
  }

  fun updateCronJob(
    original: GatewayCronJobDetail,
    edit: GatewayCronJobEdit,
  ) {
    launchCronAction(id = original.id, action = GatewayCronAction.Save) { gatewayScope, _ ->
      try {
        requestGatewayData(
          gatewayScope,
          "cron.update",
          buildCronUpdateParams(original = original, edit = edit),
        )
      } catch (err: GatewayRequestRejected) {
        if (!isCronJobRevisionConflict(err.gatewayError)) throw err
        reloadCronJobIfSelected(original.id)
        return@launchCronAction CronActionResult(
          message = nativeText("This automation changed on the gateway. Review the latest version before saving again."),
          kind = GatewayCronNoticeKind.Warning,
          refresh = false,
        )
      }
      CronActionResult(
        message = nativeText("Automation updated."),
        kind = GatewayCronNoticeKind.Success,
        refresh = true,
      )
    }
  }

  fun deleteCronJob(id: String) {
    launchCronAction(id = id, action = GatewayCronAction.Delete) { gatewayScope, jobId ->
      requestGatewayData(
        gatewayScope,
        "cron.remove",
        buildJsonObject { put("id", JsonPrimitive(jobId)) }.toString(),
      )
      CronActionResult(
        message = nativeText("Automation deleted."),
        kind = GatewayCronNoticeKind.Success,
        refresh = true,
        deleted = true,
      )
    }
  }

  fun refreshUsage() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshUsageFromGateway()
    }
  }

  fun refreshSkills() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshSkillsFromGateway()
    }
  }

  fun setSkillEnabled(
    skillKey: String,
    enabled: Boolean,
  ) {
    val normalized = skillKey.trim()
    if (normalized.isEmpty()) return
    scope.launch { setSkillEnabledOnGateway(normalized, enabled) }
  }

  fun searchClawHubSkills(query: String) {
    scope.launch { searchClawHubSkillsFromGateway(query) }
  }

  fun reviewClawHubSkillInstall(skill: GatewayClawHubSkillSummary) {
    if (skill.slug.isBlank()) return
    scope.launch { reviewClawHubSkillInstallFromGateway(skill.copy(slug = skill.slug.trim())) }
  }

  fun dismissClawHubSkillInstallReview() {
    clawHubSkillReviewSeq.incrementAndGet()
    _clawHubSkillSearchState.value =
      _clawHubSkillSearchState.value.copy(reviewingSlug = null, installReview = null)
  }

  internal fun installClawHubSkill(
    slug: String,
    acknowledgeClawHubRisk: Boolean = false,
    version: String? = null,
  ): Job? {
    val normalized = slug.trim()
    if (normalized.isEmpty()) return null
    return scope.launch {
      installClawHubSkillFromGateway(
        slug = normalized,
        acknowledgeClawHubRisk = acknowledgeClawHubRisk,
        version = version,
      )
    }
  }

  fun clearClawHubSkillMessage() {
    clawHubSkillReviewSeq.incrementAndGet()
    _clawHubSkillSearchState.value =
      _clawHubSkillSearchState.value.copy(
        reviewingSlug = null,
        installReview = null,
        acknowledgeSlug = null,
        acknowledgeVersion = null,
        errorText = null,
        messageText = null,
      )
  }

  fun refreshSkillWorkshopProposals(agentId: String? = null) {
    scope.launch {
      refreshSkillWorkshopProposalsFromGateway(agentId = agentId)
    }
  }

  fun resetSkillWorkshopAgentScope(agentId: String? = null) {
    val normalizedAgentId = normalizeSkillWorkshopAgentId(agentId)
    skillWorkshopListSeq.incrementAndGet()
    skillWorkshopInspectSeq.incrementAndGet()
    skillWorkshopMutationSeq.incrementAndGet()
    _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = normalizedAgentId, proposals = emptyList())
    _skillWorkshopRefreshing.value = false
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
    _skillWorkshopInspectingProposalId.value = null
    _skillWorkshopMutatingProposalId.value = null
  }

  fun inspectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    val normalized = proposalId.trim()
    if (normalized.isEmpty()) return
    scope.launch {
      inspectSkillWorkshopProposalFromGateway(proposalId = normalized, agentId = agentId)
    }
  }

  fun applySkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Apply)
  }

  fun rejectSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Reject)
  }

  fun quarantineSkillWorkshopProposal(
    proposalId: String,
    agentId: String? = null,
  ) {
    mutateSkillWorkshopProposal(proposalId = proposalId, agentId = agentId, action = SkillWorkshopGatewayAction.Quarantine)
  }

  private fun mutateSkillWorkshopProposal(
    proposalId: String,
    agentId: String?,
    action: SkillWorkshopGatewayAction,
  ) {
    val normalized = proposalId.trim()
    if (normalized.isEmpty()) return
    scope.launch {
      mutateSkillWorkshopProposalOnGateway(proposalId = normalized, agentId = agentId, action = action)
    }
  }

  fun clearSkillWorkshopMessage() {
    _skillWorkshopErrorText.value = null
    _skillWorkshopNoticeText.value = null
  }

  fun refreshNodesDevices() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshNodesDevicesFromGateway()
    }
  }

  fun approveDevicePairing(
    requestId: String,
    deviceId: String,
  ) {
    startDevicePairingMutation(
      mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Approve, requestId),
      expectedDeviceId = deviceId,
    )
  }

  fun rejectDevicePairing(requestId: String) {
    startDevicePairingMutation(
      mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Reject, requestId),
      expectedDeviceId = "",
    )
  }

  fun removePairedDevice(deviceId: String) {
    startDevicePairingMutation(
      mutation = GatewayDevicePairingMutation(GatewayDevicePairingAction.Remove, deviceId),
      expectedDeviceId = deviceId,
    )
  }

  private fun startDevicePairingMutation(
    mutation: GatewayDevicePairingMutation,
    expectedDeviceId: String,
  ) {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (mutation.targetId.isBlank()) return
    if (mutation.action == GatewayDevicePairingAction.Approve && expectedDeviceId.isBlank()) return
    // Capture the gateway scope at claim time: the ids were validated against the gateway the
    // user is looking at, and a reconnect/switch before the coroutine runs must not let the
    // request (especially Remove, where deviceIds recur across gateways) reach a replacement.
    val gatewayScope = captureGatewayDataScope() ?: return
    synchronized(devicePairingMutationLock) {
      if (_devicePairingMutation.value != null) return
      if (!_devicePairingCapabilities.value.supports(mutation.action)) return
      _devicePairingMutation.value = mutation
    }
    scope.launch {
      mutateDevicePairingOnGateway(gatewayScope, mutation, expectedDeviceId)
    }
  }

  fun refreshExecApprovals() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshExecApprovalsFromGateway()
    }
  }

  fun resolveExecApproval(
    id: String,
    decision: String,
  ) {
    val exactId = id.takeIf(::isWellFormedGatewayApprovalId)
    val normalizedDecision = normalizeGatewayExecApprovalDecision(decision)
    if (exactId == null || normalizedDecision == null) return
    scope.launch {
      resolveExecApprovalOnGateway(id = exactId, decision = normalizedDecision)
    }
  }

  fun dismissExecApprovalsNotice(expected: GatewayExecApprovalNotice) {
    // Atomic conditional clear: not every notice publisher holds execApprovalsStateLock
    // (refreshExecApprovalFromGateway's terminal branch), so a locked check-then-clear
    // could still let a stale dismiss clobber a freshly published replacement.
    _execApprovalsNotice.compareAndSet(expected, null)
  }

  fun refreshChannels() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshChannelsFromGateway()
    }
  }

  fun refreshDreaming() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshDreamingFromGateway()
    }
  }

  fun refreshHealthLogs() {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    scope.launch {
      refreshHealthLogsFromGateway()
    }
  }

  fun requestCanvasRehydrate(
    source: String = "manual",
    force: Boolean = true,
  ) {
    val gatewayId = connectedEndpoint?.stableId
    scope.launch {
      if (gatewayId == null || !_nodeConnected.value) {
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = nativeText("Node offline. Reconnect and retry.")
        return@launch
      }
      if (!force && didAutoRequestCanvasRehydrate) return@launch
      didAutoRequestCanvasRehydrate = true
      val requestId = canvasRehydrateSeq.incrementAndGet()
      _canvasRehydratePending.value = true
      _canvasRehydrateErrorText.value = null

      val sessionKey = resolveMainSessionKey()
      val prompt =
        "Restore canvas now for session=$sessionKey source=$source. " +
          "If existing A2UI state exists, replay it immediately. " +
          "If not, create and render a compact mobile-friendly dashboard in Canvas."
      val sent =
        nodeSession.sendNodeEventForEndpoint(
          expectedEndpointStableId = gatewayId,
          event = "agent.request",
          payloadJson =
            buildJsonObject {
              put("message", JsonPrimitive(prompt))
              put("sessionKey", JsonPrimitive(sessionKey))
              put("thinking", JsonPrimitive("low"))
              put("deliver", JsonPrimitive(false))
            }.toString(),
        )
      if (!sent) {
        if (!force) {
          didAutoRequestCanvasRehydrate = false
        }
        if (canvasRehydrateSeq.get() == requestId) {
          _canvasRehydratePending.value = false
          _canvasRehydrateErrorText.value = nativeText("Failed to request restore. Tap to retry.")
        }
        Log.w("OpenClawCanvas", "canvas rehydrate request failed ($source): transport unavailable")
        return@launch
      }
      scope.launch {
        delay(20_000)
        if (canvasRehydrateSeq.get() != requestId) return@launch
        if (!_canvasRehydratePending.value) return@launch
        if (_canvasA2uiHydrated.value) return@launch
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = nativeText("No canvas update yet. Tap to retry.")
      }
    }
  }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val locationMode: StateFlow<LocationMode> = prefs.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = prefs.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val manualTls: StateFlow<Boolean> = prefs.manualTls
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted

  /** Clears setup credentials plus paired device tokens for both Android gateway roles. */
  suspend fun resetGatewaySetupAuth(stableId: String): Boolean =
    gatewayLifecycleIntentSeq.incrementAndGet().let { intent ->
      gatewaySwitchMutex.withLock {
        if (intent != gatewayLifecycleIntentSeq.get()) false else resetGatewaySetupAuthLocked(stableId)
      }
    }

  private suspend fun resetGatewaySetupAuthLocked(stableId: String): Boolean {
    val connectOperationsDrained =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          null
        } else {
          gatewayAuthResetInProgress = true
          gatewayConnectOperationsDrained
        }
      }
        ?: return false
    return try {
      connectOperationsDrained.await()
      if (connectedEndpoint?.stableId == stableId) {
        disconnectAndJoin()
      }
      if (connectingEndpointStableId == stableId) {
        connectAttemptSeq.incrementAndGet()
        connectingEndpointStableId = null
        _pendingGatewayTrust.value = null
        chat.onGatewayScopeChanging(retireRunState = true)
      }
      drainIdleGatewaySessionTails()
      // A deliberate disconnect retains reconnect ownership. Authentication replacement does not.
      chat.onGatewayScopeChanging(retireRunState = true)
      // Replacing authentication retires the old identity even when the endpoint is unchanged.
      // Purge only that gateway; ordinary switches retain every gateway's offline state.
      val cacheCleared =
        runCatching {
          chat.clearGatewayCache(stableId) {
            clientDatabases.commitGatewayRemoval(stableId, requireCacheRemoval = true)
            externalTranscriptCache?.clearGateway(stableId)
          }
        }.onFailure { err ->
          Log.e("OpenClawRuntime", "Failed to purge gateway chat data before auth reset", err)
          setStandaloneGatewayStatus("Failed: couldn't clear offline chat data. Retry sign out.")
        }.isSuccess
      if (!cacheCleared) return false
      prefs.clearGatewayCredentials(stableId)
      val deviceId = identityStore.loadOrCreate().deviceId
      deviceAuthStore.clearToken(stableId, deviceId, "node")
      deviceAuthStore.clearToken(stableId, deviceId, "operator")
      true
    } finally {
      synchronized(gatewayAuthLifecycleLock) { gatewayAuthResetInProgress = false }
    }
  }

  /** Persists onboarding state; callers decide whether runtime startup is needed first. */
  fun setOnboardingCompleted(value: Boolean) = prefs.setOnboardingCompleted(value)

  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
  val pairedGateways: StateFlow<List<GatewayRegistryEntry>> = prefs.gatewayRegistry.entries
  val activeGatewayStableId: StateFlow<String?> = prefs.gatewayRegistry.activeStableId
  val connectedGatewayStableIds: StateFlow<List<String>> = prefs.gatewayRegistry.connectedStableIds
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled
  val installedAppsSharingEnabled: StateFlow<Boolean> = prefs.installedAppsSharingEnabled
  val notificationForwardingEnabled: StateFlow<Boolean> = prefs.notificationForwardingEnabled
  val notificationForwardingMode: StateFlow<NotificationPackageFilterMode> =
    prefs.notificationForwardingMode
  val notificationForwardingPackages: StateFlow<Set<String>> = prefs.notificationForwardingPackages
  val notificationForwardingQuietHoursEnabled: StateFlow<Boolean> =
    prefs.notificationForwardingQuietHoursEnabled
  val notificationForwardingQuietStart: StateFlow<String> = prefs.notificationForwardingQuietStart
  val notificationForwardingQuietEnd: StateFlow<String> = prefs.notificationForwardingQuietEnd
  val notificationForwardingMaxEventsPerMinute: StateFlow<Int> =
    prefs.notificationForwardingMaxEventsPerMinute
  val notificationForwardingSessionKey: StateFlow<String?> = prefs.notificationForwardingSessionKey

  private var didAutoConnect = false

  @Volatile private var preferredGatewayReconnectSuppressed = initialReconnectSuppressed
  private val secondaryGatewayConnectionsEnabled = MutableStateFlow(!initialReconnectSuppressed)

  val chatSessionKey: StateFlow<String> = chat.sessionKey
  val chatSessionOwnerAgentId: StateFlow<String?> = chat.sessionOwnerAgentId
  internal val gatewayComposerDefaultAgentOwner: StateFlow<GatewayDefaultAgentOwner?> = chat.composerDefaultAgentOwner
  val chatSessionId: StateFlow<String?> = chat.sessionId
  val chatMessages: StateFlow<List<ChatMessage>> = chat.messages
  val chatHistoryLoading: StateFlow<Boolean> = chat.historyLoading
  val chatError: StateFlow<String?> = chat.errorText
  val chatHealthOk: StateFlow<Boolean> = chat.healthOk
  val chatThinkingLevel: StateFlow<String> = chat.thinkingLevel
  val chatThinkingLevelSelection: StateFlow<ChatThinkingLevelSelection> = chat.thinkingLevelSelection
  val chatSelectedModelRef: StateFlow<String?> = chat.selectedModelRef
  val chatModelCatalog: StateFlow<List<GatewayModelSummary>> = chat.modelCatalog
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatQuestions: StateFlow<List<ChatQuestionPrompt>> = chat.questions
  val chatPlanSteps: StateFlow<List<ChatPlanStep>> = chat.planSteps
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount
  val chatCommands: StateFlow<List<ChatCommandEntry>> = chat.commands
  val chatOutboxItems: StateFlow<List<ChatOutboxItem>> = chat.outboxItems

  suspend fun listBackgroundTasks(agentId: String): List<BackgroundTask> = chat.listBackgroundTasks(agentId)

  suspend fun getBackgroundTask(taskId: String): BackgroundTask = chat.getBackgroundTask(taskId)

  fun retryChatOutboxCommand(id: String) = chat.retryOutboxCommand(id)

  fun deleteChatOutboxCommand(id: String) = chat.deleteOutboxCommand(id)

  fun resolveChatQuestion(
    id: String,
    answers: Map<String, List<String>>,
  ) = chat.resolveQuestion(id, answers)

  fun skipChatQuestion(id: String) = chat.skipQuestion(id)

  private fun applyScreenshotFixture() {
    check(BuildConfig.DEBUG) { "Android screenshot fixtures require a debug build" }
    _serverName.value = "OpenClaw Gateway"
    _remoteAddress.value = "Mac Studio on local network"
    _gatewayVersion.value = BuildConfig.VERSION_NAME
    updateGatewayDefaultAgentId("main")
    _gatewayAgents.value = AndroidScreenshotFixture.agents
    _modelCatalog.value = AndroidScreenshotFixture.models
    _providerModelCatalog.value = AndroidScreenshotFixture.models
    _modelAuthProviders.value = AndroidScreenshotFixture.providers
    _talkSetupReadiness.value =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupState.Ready(GatewayTalkProvider("openai", "OpenAI")),
        dictation = GatewayTalkSetupState.Ready(GatewayTalkProvider("openai", "OpenAI")),
      )
    _cronStatus.value =
      GatewayCronStatus(
        enabled = true,
        jobs = 1,
        nextWakeAtMs = 1_783_641_600_000,
      )
    _cronJobs.value = parseScreenshotCronJobs()
    _operatorScopes.value = listOf(OperatorAdminScope)
    _nodesDevicesSummary.value = AndroidScreenshotFixture.nodes
    _channelsSummary.value = AndroidScreenshotFixture.channels
    _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Approved
    _mainSessionKey.value = AndroidScreenshotFixture.mainSessionKey
    chat.applyMainSessionKey(AndroidScreenshotFixture.mainSessionKey)
    updateStatus {
      operatorConnected = true
      operatorStatusText = "Connected"
      _nodeConnected.value = true
      nodeStatusText = "Connected"
      operatorConnectionProblem = null
      nodeConnectionProblem = null
    }
    chat.refreshSessions(limit = 20)
  }

  private fun parseScreenshotCronJobs(): List<GatewayCronJobSummary> {
    // Screenshot mode parses gateway-shaped fixtures so UI navigation covers the live data contract.
    val list =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.list", null))
        .asObjectOrNull()
    return parseCronJobs(list?.get("jobs") as? JsonArray)
  }

  private fun applyScreenshotCronDetail(
    detailRequest: CronJobDetailRequest,
    historyRequest: CronJobDetailRequest,
  ) {
    val detail =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.get", cronJobGetParams(detailRequest.id)))
        .asObjectOrNull()
        ?.let(::parseGatewayCronJobDetail)
        ?.takeIf { it.id == detailRequest.id }
    cronJobDetailRequestGuard.publishIfCurrent(detailRequest) {
      _cronJobDetailState.value =
        detail?.let(GatewayCronJobDetailState::Loaded)
          ?: GatewayCronJobDetailState.Error(detailRequest.id, nativeText("Gateway returned an invalid automation."))
    }
    publishScreenshotCronHistory(historyRequest)
  }

  private fun publishScreenshotCronHistory(request: CronJobDetailRequest) {
    val history =
      json
        .parseToJsonElement(AndroidScreenshotFixture.request("cron.runs", cronJobGetParams(request.id)))
        .asObjectOrNull()
    val runs = parseGatewayCronRunHistory(history?.get("entries") as? JsonArray)
    cronRunHistoryRequestGuard.publishIfCurrent(request) {
      _cronRunHistoryState.value = GatewayCronRunHistoryState.Loaded(id = request.id, runs = runs)
    }
  }

  init {
    if (mode == NodeRuntimeMode.Live) {
      if (initialForeground && prefs.voiceMicEnabled.value) {
        setVoiceCaptureMode(VoiceCaptureMode.ManualMic, persistManualMic = false)
      } else if (!initialForeground && prefs.voiceMicEnabled.value) {
        // Process recovery without an Activity must not revive microphone capture.
        prefs.setVoiceMicEnabled(false)
      }

      scope.launch(Dispatchers.Default) {
        gateways.collect { list ->
          seedLastDiscoveredGateway(list)
          autoConnectIfNeeded()
        }
      }
      scope.launch(Dispatchers.Default) {
        combine(
          prefs.gatewayRegistry.entries,
          prefs.gatewayRegistry.connectedStableIds,
          prefs.gatewayRegistry.activeStableId,
          gateways,
          combine(_isForeground, secondaryGatewayConnectionsEnabled) { foreground, enabled ->
            foreground && enabled
          },
        ) { entries, connectedIds, activeId, discovered, shouldRun ->
          BackgroundGatewayFleetSnapshot(entries, connectedIds, activeId, discovered, shouldRun)
        }.distinctUntilChanged()
          .collect(::reconcileBackgroundGatewayFleet)
      }
    } else {
      applyScreenshotFixture()
    }

    if (mode == NodeRuntimeMode.Live) {
      invalidateVoiceWakeWordsForGateway()
    }
    reconcileVoiceWakeCaptureSuppression()
    voiceWakeManager.setForeground(initialForeground)
    voiceWakeManager.setEnabled(prefs.voiceWakeEnabled.value)
    scope.launch {
      micCapture.micCooldown.collect {
        // Manual capture drains partial audio for two seconds after its toggle
        // turns off. Resume Voice Wake only after that capture owner releases.
        reconcileVoiceWakeCaptureSuppression()
      }
    }

    scope.launch {
      combine(
        canvasDebugStatusEnabled,
        statusText,
        serverName,
        remoteAddress,
      ) { debugEnabled, status, server, remote ->
        Quad(debugEnabled, status, server, remote)
      }.distinctUntilChanged()
        .collect { (debugEnabled, status, server, remote) ->
          canvas.setDebugStatusEnabled(debugEnabled)
          if (!debugEnabled) return@collect
          canvas.setDebugStatus(status, server ?: remote)
        }
    }

    scope.launch {
      nativeLocaleChanges.drop(1).collect {
        updateHomeCanvasState()
      }
    }

    scope.launch {
      chatModelCatalog.drop(1).distinctUntilChanged().collect {
        // Chat metadata arrives after the connection event. Invalidate the Watch snapshot so
        // its Home model picker cannot stay empty until the user refreshes manually.
        if (operatorSession.isReady()) wearProxyBridge()?.publishResync()
      }
    }

    updateHomeCanvasState()
  }

  /** Updates foreground state and triggers reconnect/presence behavior on app visibility changes. */
  fun setForeground(value: Boolean) {
    _isForeground.value = value
    voiceWakeManager.setForeground(value)
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!value) {
      voiceLifecycleEpoch.incrementAndGet()
    }
    if (value) {
      refreshVoiceWakeCapabilitySurfaceIfChanged()
      reconnectPreferredGatewayOnForeground()
      scope.launch {
        refreshExecApprovalsFromGateway()
      }
    } else {
      stopMessageSpeech()
      stopActiveVoiceSession()
      publishNodePresenceAliveBeacon(NodePresenceAliveBeacon.Trigger.Background, throttleRecentSuccess = true)
    }
  }

  private fun publishNodePresenceAliveBeacon(
    trigger: NodePresenceAliveBeacon.Trigger,
    throttleRecentSuccess: Boolean = false,
  ) {
    val gatewayId = connectedEndpoint?.stableId ?: return
    scope.launch {
      sendNodePresenceAliveBeacon(
        gatewayId = gatewayId,
        trigger = trigger,
        throttleRecentSuccess = throttleRecentSuccess,
      )
    }
  }

  private suspend fun sendNodePresenceAliveBeacon(
    gatewayId: String,
    trigger: NodePresenceAliveBeacon.Trigger,
    throttleRecentSuccess: Boolean,
  ) {
    if (!_nodeConnected.value) return
    val nowMs = System.currentTimeMillis()
    if (
      throttleRecentSuccess &&
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        nowMs = nowMs,
        lastSuccessAtMs = nodePresenceAliveLastSuccessAtMs,
      )
    ) {
      return
    }

    val client = connectionManager.buildClientInfo(clientId = "openclaw-android", clientMode = "node")
    val payloadJson =
      NodePresenceAliveBeacon.makePayloadJson(
        trigger = trigger,
        sentAtMs = nowMs,
        displayName = client.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: "Android",
        version = client.version,
        platform = NodePresenceAliveBeacon.androidPlatformMetadata(),
        deviceFamily = client.deviceFamily,
        modelIdentifier = client.modelIdentifier,
      )
    val result =
      nodeSession.sendNodeEventDetailedForEndpoint(
        expectedEndpointStableId = gatewayId,
        event = NodePresenceAliveBeacon.EVENT_NAME,
        payloadJson = payloadJson,
      )
    if (!result.ok) return
    val response = NodePresenceAliveBeacon.decodeResponse(result.payloadJson)
    if (response?.handled == true) {
      nodePresenceAliveLastSuccessAtMs = nowMs
    } else {
      Log.d(
        "OpenClawNode",
        "node.presence.alive not handled: ${NodePresenceAliveBeacon.sanitizeReasonForLog(response?.reason)}",
      )
    }
  }

  private fun seedLastDiscoveredGateway(list: List<GatewayEndpoint>) {
    if (list.isEmpty()) return
    if (lastDiscoveredStableId.value.trim().isNotEmpty()) return
    prefs.setLastDiscoveredStableId(list.first().stableId)
  }

  private data class BackgroundGatewayFleetSnapshot(
    val entries: List<GatewayRegistryEntry>,
    val connectedIds: List<String>,
    val activeId: String?,
    val discovered: List<GatewayEndpoint>,
    val shouldRun: Boolean,
  )

  private suspend fun reconcileBackgroundGatewayFleet(snapshot: BackgroundGatewayFleetSnapshot) {
    val desired =
      if (!snapshot.shouldRun) {
        emptyMap()
      } else {
        backgroundGatewayStableIds(
          entries = snapshot.entries,
          connectedIds = snapshot.connectedIds,
          activeId = snapshot.activeId,
          foreground = true,
        ).asSequence()
          .mapNotNull { stableId ->
            val entry = snapshot.entries.firstOrNull { it.stableId == stableId } ?: return@mapNotNull null
            val endpoint = resolveRegistryEndpoint(entry, snapshot.discovered) ?: return@mapNotNull null
            stableId to endpoint
          }.toMap()
      }

    secondaryOperatorSessions.keys
      .filterNot(desired::containsKey)
      .forEach { stableId ->
        secondaryOperatorSessions.remove(stableId)?.session?.disconnectAndJoin()
        updateBackgroundGatewayStatus(stableId, null)
      }

    for ((stableId, endpoint) in desired) {
      val existing = secondaryOperatorSessions[stableId]
      if (existing?.endpoint == endpoint) continue
      existing?.session?.disconnectAndJoin()
      val auth = resolveGatewayConnectAuth(endpoint)
      val storedOperatorEntry = loadStoredRoleDeviceAuthEntry(endpoint, "operator")
      val operatorAuth = resolveOperatorSessionConnectAuth(auth, storedOperatorEntry?.token)
      if (operatorAuth == null) {
        updateBackgroundGatewayStatus(stableId, "Needs setup")
        secondaryOperatorSessions.remove(stableId)
        continue
      }
      val session =
        GatewaySession(
          scope = scope,
          identityStore = identityStore,
          deviceAuthStore = deviceAuthStore,
          onConnected = {
            prefs.gatewayRegistry.markConnected(stableId, System.currentTimeMillis())
            updateBackgroundGatewayStatus(stableId, "Connected")
          },
          onDisconnected = { message -> updateBackgroundGatewayStatus(stableId, message) },
          onConnectFailure = { error, _ -> updateBackgroundGatewayStatus(stableId, error.message) },
          // Secondary sessions retain authenticated presence only. Focused UI state and
          // capability commands remain exclusively owned by the active runtime sessions.
          onEvent = { _, _ -> },
          customHeadersProvider = prefs::loadGatewayCustomHeaders,
        )
      secondaryOperatorSessions[stableId] = SecondaryOperatorRuntime(endpoint, session)
      updateBackgroundGatewayStatus(stableId, "Connecting…")
      val usesStoredOperatorDeviceToken =
        operatorSessionUsesStoredDeviceToken(auth, storedOperatorEntry?.token)
      session.connect(
        endpoint,
        operatorAuth.token,
        operatorAuth.bootstrapToken,
        operatorAuth.password,
        connectionManager.buildOperatorConnectOptions(
          scopes =
            operatorConnectScopesForAuth(
              usesStoredDeviceToken = usesStoredOperatorDeviceToken,
              storedOperatorScopes = storedOperatorEntry?.scopes,
            ),
        ),
        connectionManager.resolveTlsParams(endpoint),
      )
    }
  }

  private fun resolveRegistryEndpoint(
    entry: GatewayRegistryEntry,
    discovered: List<GatewayEndpoint> = gateways.value,
  ): GatewayEndpoint? {
    return when (entry.kind) {
      GatewayRegistryEntryKind.MANUAL -> {
        val host = entry.host?.trim().orEmpty()
        val port = entry.port ?: return null
        if (host.isEmpty() || port !in 1..65535) return null
        GatewayEndpoint.manual(host = host, port = port)
      }
      GatewayRegistryEntryKind.DISCOVERED -> {
        val endpoint = discovered.firstOrNull { it.stableId == entry.stableId } ?: return null
        val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
        endpoint.takeIf { storedFingerprint.isNotEmpty() }
      }
    }
  }

  private fun updateBackgroundGatewayStatus(
    stableId: String,
    status: String?,
  ) {
    synchronized(secondaryOperatorSessions) {
      _backgroundGatewayStatuses.value =
        if (status == null) {
          _backgroundGatewayStatuses.value - stableId
        } else {
          _backgroundGatewayStatuses.value + (stableId to status)
        }
    }
  }

  private fun resolvePreferredGatewayEndpoint(): GatewayEndpoint? {
    val entry = prefs.gatewayRegistry.activeEntry() ?: return null
    return resolveRegistryEndpoint(entry)
  }

  suspend fun switchToGateway(stableId: String): Boolean {
    val entry =
      prefs.gatewayRegistry.entries.value
        .firstOrNull { it.stableId == stableId } ?: return false
    val endpoint =
      when (entry.kind) {
        GatewayRegistryEntryKind.MANUAL -> {
          val host = entry.host?.trim().orEmpty()
          val port = entry.port ?: return false
          if (host.isEmpty() || port !in 1..65535) return false
          GatewayEndpoint.manual(host, port)
        }
        GatewayRegistryEntryKind.DISCOVERED ->
          gateways.value.firstOrNull { it.stableId == stableId }
            ?: run {
              setStandaloneGatewayStatus("Gateway not currently discoverable")
              return false
            }
      }
    return connectSwitchingGateway(endpoint)
  }

  fun setGatewayConnectionEnabled(
    stableId: String,
    enabled: Boolean,
  ) {
    if (enabled) secondaryGatewayConnectionsEnabled.value = true
    prefs.gatewayRegistry.setConnectionEnabled(stableId, enabled)
  }

  suspend fun connectSwitchingGateway(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth? = null,
  ): Boolean {
    preferredGatewayReconnectSuppressed = false
    secondaryGatewayConnectionsEnabled.value = true
    val intent = gatewayLifecycleIntentSeq.incrementAndGet()
    return gatewaySwitchMutex.withLock {
      if (intent != gatewayLifecycleIntentSeq.get()) return@withLock false
      val currentStableId =
        connectedEndpoint?.stableId
          ?: connectingEndpointStableId
          ?: prefs.gatewayRegistry.activeStableId.value
      if (currentStableId != null && currentStableId != endpoint.stableId) {
        disconnectAndJoin()
      }
      if (prefs.gatewayRegistry.entries.value
          .any { it.stableId == endpoint.stableId }
      ) {
        prefs.gatewayRegistry.setActive(endpoint.stableId)
      }
      val started =
        synchronized(gatewayLifecycleIntentLock) {
          if (intent != gatewayLifecycleIntentSeq.get()) {
            false
          } else {
            beginConnect(endpoint, resolveGatewayConnectAuth(endpoint, explicitAuth))
            true
          }
        }
      if (!started) return@withLock false
      chat.restoreSelectedGatewayOfflineState()
      true
    }
  }

  private fun autoConnectIfNeeded() {
    if (preferredGatewayReconnectSuppressed) return
    if (didAutoConnect) return
    if (gatewayConnectionDisplay.value.isConnected) return
    val endpoint = resolvePreferredGatewayEndpoint() ?: return
    // Only attempt the stored preferred gateway once per runtime lifetime; users
    // can still reconnect explicitly from the UI after a failed auto attempt.
    didAutoConnect = true
    // Cold-start fallback only: discovery can emit late, so atomically claim the very first
    // lifecycle intent. If any explicit connect/disconnect/switch intent already exists, stand
    // down permanently instead of overriding the user's decision with a stale auto-connect.
    if (!gatewayLifecycleIntentSeq.compareAndSet(0L, 1L)) return
    launchConnect(endpoint, explicitAuth = null)
  }

  private fun reconnectPreferredGatewayOnForeground() {
    if (preferredGatewayReconnectSuppressed) return
    if (gatewayConnectionDisplay.value.isConnected) return
    if (_pendingGatewayTrust.value != null) return
    if (connectedEndpoint != null) {
      refreshGatewayConnection()
      return
    }
    resolvePreferredGatewayEndpoint()?.let(::connect)
  }

  fun setDisplayName(value: String) {
    prefs.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    if (prefs.cameraEnabled.value == value) return
    prefs.setCameraEnabled(value)
    refreshNodeSurfaceAfterSettingsChange()
  }

  fun setLocationMode(mode: LocationMode) {
    if (prefs.locationMode.value == mode) return
    prefs.setLocationMode(mode)
    refreshNodeSurfaceAfterSettingsChange()
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    prefs.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    prefs.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    prefs.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    prefs.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    prefs.setManualPort(value)
  }

  fun setManualTls(value: Boolean) {
    prefs.setManualTls(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun grantInstalledAppsDisclosureConsent() {
    if (prefs.installedAppsSharingEnabled.value) return
    prefs.grantInstalledAppsDisclosureConsent()
    refreshNodeSurfaceAfterSettingsChange()
  }

  fun revokeInstalledAppsDisclosureConsent() {
    if (!prefs.installedAppsSharingEnabled.value) return
    prefs.revokeInstalledAppsDisclosureConsent()
    refreshNodeSurfaceAfterSettingsChange()
  }

  fun setNotificationForwardingEnabled(value: Boolean) {
    if (prefs.notificationForwardingEnabled.value == value) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingEnabled(value) }
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    if (prefs.notificationForwardingMode.value == mode) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingMode(mode) }
  }

  fun setNotificationForwardingPackages(packages: List<String>) {
    val normalized = packages.map(String::trim).filter(String::isNotEmpty).toSet()
    if (prefs.notificationForwardingPackages.value == normalized) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingPackages(normalized.toList()) }
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean {
    if (!enabled) {
      if (!prefs.notificationForwardingQuietHoursEnabled.value) return true
      return notificationOutbox.updatePolicy {
        prefs.setNotificationForwardingQuietHours(enabled = false, start = start, end = end)
      }
    }
    val normalizedStart = normalizeLocalHourMinute(start) ?: return false
    val normalizedEnd = normalizeLocalHourMinute(end) ?: return false
    val unchanged =
      prefs.notificationForwardingQuietHoursEnabled.value &&
        prefs.notificationForwardingQuietStart.value == normalizedStart &&
        prefs.notificationForwardingQuietEnd.value == normalizedEnd
    if (unchanged) return true
    return notificationOutbox.updatePolicy {
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = normalizedStart,
        end = normalizedEnd,
      )
    }
  }

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    val normalized = value.coerceAtLeast(1)
    if (prefs.notificationForwardingMaxEventsPerMinute.value == normalized) return
    notificationOutbox.updatePolicy {
      prefs.setNotificationForwardingMaxEventsPerMinute(normalized)
    }
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    val normalized = value?.trim()?.takeIf(String::isNotEmpty)
    if (prefs.notificationForwardingSessionKey.value == normalized) return
    notificationOutbox.updatePolicy { prefs.setNotificationForwardingSessionKey(normalized) }
  }

  fun setVoiceScreenActive(active: Boolean) {
    if (mode == NodeRuntimeMode.ScreenshotFixture) return
    if (!active) {
      stopManualVoiceSession()
    } else {
      refreshTalkSetupReadiness()
    }
    // Don't re-enable on active=true; mic toggle drives that
  }

  fun setMicEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.ManualMic else VoiceCaptureMode.Off)
  }

  internal fun tryAcquireVoiceNoteMic(): Boolean {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        if (voiceNoteOwnsMic || dictationOwnsMic || !isVoiceCaptureModeActive(VoiceCaptureMode.Off)) return false
        voiceNoteOwnsMic = true
        createVoiceWakeSuppressionUpdateLocked(VoiceWakeSuppressionReason.VoiceNote, true)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
    return true
  }

  internal fun releaseVoiceNoteMic() {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        voiceNoteOwnsMic = false
        createVoiceWakeSuppressionUpdateLocked(VoiceWakeSuppressionReason.VoiceNote, false)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  internal fun tryAcquireDictationMic(): Boolean {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        if (
          dictationOwnsMic ||
          voiceNoteOwnsMic ||
          cameraAudioOwnsMic ||
          !isVoiceCaptureModeActive(VoiceCaptureMode.Off)
        ) {
          return false
        }
        dictationOwnsMic = true
        createVoiceWakeSuppressionUpdateLocked(VoiceWakeSuppressionReason.Dictation, true)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
    return true
  }

  internal fun releaseDictationMic() {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        dictationOwnsMic = false
        createVoiceWakeSuppressionUpdateLocked(VoiceWakeSuppressionReason.Dictation, false)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  fun cancelMicCapture() {
    micCapture.cancelMicCapture()
    setVoiceCaptureMode(VoiceCaptureMode.Off, persistManualMic = false)
    prefs.setVoiceMicEnabled(false)
  }

  fun setTalkModeEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.TalkMode else VoiceCaptureMode.Off)
  }

  private suspend fun handleTalkPttStart(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      talkMode.finishingPushToTalkCaptureId?.let {
        return@runTalkPttCommand GatewaySession.InvokeResult.error(
          code = "PTT_BUSY",
          message = "PTT_BUSY: previous push-to-talk turn is still finishing",
        )
      }
      val lifecycleEpoch = voiceLifecycleEpoch.get()
      val commandEpoch = talkPttCommandEpoch.get()
      if (!_isForeground.value) {
        val payload = talkMode.beginPushToTalk(allowNewCapture = false)
        return@runTalkPttCommand GatewaySession.InvokeResult.ok(payload.toJson())
      }
      val payload =
        withPreparedTalkPttCommand(lifecycleEpoch, commandEpoch) { ownershipEpoch ->
          val started =
            talkMode.beginPushToTalk(
              allowNewCapture = true,
              canStartCapture = {
                _isForeground.value &&
                  voiceLifecycleEpoch.get() == lifecycleEpoch &&
                  talkPttCommandEpoch.get() == commandEpoch &&
                  voiceCaptureOwnershipEpoch.get() == ownershipEpoch
              },
            )
          recordTalkPttOwnership(captureId = started.captureId, ownershipEpoch = ownershipEpoch)
          started
        }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttStop(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = stopPreparedTalkPttCapture { talkMode.endPushToTalk() }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttCancel(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      val payload = stopPreparedTalkPttCapture { talkMode.cancelPushToTalk() }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private suspend fun handleTalkPttOnce(): GatewaySession.InvokeResult =
    runTalkPttCommand {
      currentTalkPttOnceBusy()?.let { busy ->
        return@runTalkPttCommand GatewaySession.InvokeResult.ok(busy.payload.toJson())
      }
      val lifecycleEpoch = voiceLifecycleEpoch.get()
      val commandEpoch = talkPttCommandEpoch.get()
      val start =
        withPreparedTalkPttCommand(
          lifecycleEpoch = lifecycleEpoch,
          commandEpoch = commandEpoch,
          beforePrepare = ::currentTalkPttOnceBusy,
        ) { ownershipEpoch ->
          val started =
            talkMode.beginPushToTalkOnce(
              canStartCapture = {
                _isForeground.value &&
                  voiceLifecycleEpoch.get() == lifecycleEpoch &&
                  talkPttCommandEpoch.get() == commandEpoch &&
                  voiceCaptureOwnershipEpoch.get() == ownershipEpoch
              },
            )
          when (started) {
            is TalkPttOnceStart.Busy -> cleanupFailedTalkCapture(ownershipEpoch)
            is TalkPttOnceStart.Started ->
              recordTalkPttOwnership(captureId = started.captureId, ownershipEpoch = ownershipEpoch)
          }
          started
        }
      val payload =
        try {
          talkMode.awaitPushToTalkOnce(start)
        } finally {
          if (start is TalkPttOnceStart.Started) {
            finishTalkCaptureIfIdleAfterPreparation(start.captureId)
          }
        }
      GatewaySession.InvokeResult.ok(payload.toJson())
    }

  private fun currentTalkPttOnceBusy(): TalkPttOnceStart.Busy? {
    val captureId = talkMode.activePushToTalkCaptureId ?: talkMode.finishingPushToTalkCaptureId ?: return null
    return TalkPttOnceStart.Busy(
      TalkPttStopPayload(captureId = captureId, transcript = null, status = "busy"),
    )
  }

  private suspend fun <T> withPreparedTalkPttCommand(
    lifecycleEpoch: Long,
    commandEpoch: Long,
    beforePrepare: () -> T? = { null },
    block: suspend (ownershipEpoch: Long) -> T,
  ): T =
    voiceCapturePreparationMutex.withLock {
      // Preparation suspends while gateway config loads. Serialize ownership so
      // a stale command cannot clean up a newer command before capture starts.
      if (
        !_isForeground.value ||
        voiceLifecycleEpoch.get() != lifecycleEpoch ||
        talkPttCommandEpoch.get() != commandEpoch
      ) {
        throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
      }
      beforePrepare()?.let { return@withLock it }
      val ownershipEpoch = prepareTalkCapture(lifecycleEpoch, commandEpoch)
      try {
        if (
          !_isForeground.value ||
          voiceLifecycleEpoch.get() != lifecycleEpoch ||
          talkPttCommandEpoch.get() != commandEpoch ||
          voiceCaptureOwnershipEpoch.get() != ownershipEpoch
        ) {
          throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
        }
        block(ownershipEpoch)
      } catch (err: Throwable) {
        cleanupFailedTalkCapture(ownershipEpoch)
        throw err
      }
    }

  private suspend fun runTalkPttCommand(block: suspend () -> GatewaySession.InvokeResult): GatewaySession.InvokeResult =
    try {
      block()
    } catch (err: Throwable) {
      val (code, message) = invokeErrorFromThrowable(err)
      GatewaySession.InvokeResult.error(code = code, message = message)
    }

  private suspend fun prepareTalkCapture(
    lifecycleEpoch: Long,
    commandEpoch: Long,
  ): Long {
    // Publish preparation on Main with lifecycle shutdown. After this block
    // yields, preparation must not write capture state that backgrounding cleared.
    val (ownershipEpoch, suppressionUpdate) =
      withContext(Dispatchers.Main) {
        synchronized(voiceCaptureOwnershipLock) {
          if (
            !_isForeground.value ||
            voiceLifecycleEpoch.get() != lifecycleEpoch ||
            talkPttCommandEpoch.get() != commandEpoch
          ) {
            throw IllegalStateException("NODE_BACKGROUND_UNAVAILABLE: command requires foreground")
          }
          if (voiceNoteOwnsMic) {
            throw IllegalStateException("MIC_BUSY: voice note recording is active")
          }
          if (dictationOwnsMic) {
            throw IllegalStateException("MIC_BUSY: dictation is active")
          }
          if (cameraAudioOwnsMic) {
            throw IllegalStateException("MIC_BUSY: camera audio recording is active")
          }
          if (!hasRecordAudioPermission()) {
            throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
          }
          val epoch = voiceCaptureOwnershipEpoch.incrementAndGet()
          val update = setExternalAudioCaptureActiveLocked(true)
          micCapture.setMicEnabled(false)
          stopVoicePlayback()
          NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
          talkMode.ttsOnAllResponses = true
          talkMode.setPlaybackEnabled(speakerEnabled.value)
          epoch to update
        }
      }
    applyVoiceWakeSuppression(suppressionUpdate)
    try {
      talkMode.refreshConfig()
      return ownershipEpoch
    } catch (err: Throwable) {
      cleanupFailedTalkCapture(ownershipEpoch)
      throw err
    }
  }

  private fun cleanupFailedTalkCapture(ownershipEpoch: Long) {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        // TalkModeManager owns capture-scoped cancellation. A stale invoke must not
        // tear down a newer capture after a background/foreground transition.
        if (voiceCaptureOwnershipEpoch.get() == ownershipEpoch) {
          talkMode.activePushToTalkCaptureId?.let { captureId ->
            // An idempotent retry can fail while the original capture remains live.
            // Transfer preparation ownership so its eventual stop still cleans up.
            talkPttOwnership.set(TalkPttOwnership(captureId = captureId, epoch = ownershipEpoch))
            return
          }
        }
        finishTalkCaptureIfIdleUnderOwnershipLock(ownershipEpoch)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  private fun recordTalkPttOwnership(
    captureId: String,
    ownershipEpoch: Long,
  ) {
    synchronized(voiceCaptureOwnershipLock) {
      if (voiceCaptureOwnershipEpoch.get() == ownershipEpoch) {
        talkPttOwnership.set(TalkPttOwnership(captureId = captureId, epoch = ownershipEpoch))
      }
    }
  }

  private suspend fun finishTalkCaptureIfIdleAfterPreparation(captureId: String) {
    withContext(NonCancellable) {
      voiceCapturePreparationMutex.withLock {
        finishTalkCaptureIfIdleLocked(captureId)
      }
    }
  }

  private suspend fun stopPreparedTalkPttCapture(
    stopCapture: suspend () -> TalkPttStopPayload,
  ): TalkPttStopPayload {
    // Preparation can suspend on gateway config. Invalidate it before waiting,
    // while later starts queue behind this stop with the new command epoch.
    talkPttCommandEpoch.incrementAndGet()
    return withContext(NonCancellable) {
      voiceCapturePreparationMutex.withLock {
        val payload = stopCapture()
        finishTalkCaptureIfIdleLocked(payload.captureId)
        payload
      }
    }
  }

  private fun finishTalkCaptureIfIdleLocked(captureId: String) {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        val ownership = talkPttOwnership.get()
        if (ownership?.captureId != captureId || !talkPttOwnership.compareAndSet(ownership, null)) return
        finishTalkCaptureIfIdleUnderOwnershipLock(ownership.epoch)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  private fun finishTalkCaptureIfIdleUnderOwnershipLock(ownershipEpoch: Long): VoiceWakeSuppressionUpdate? {
    if (ownershipEpoch == 0L || voiceCaptureOwnershipEpoch.get() != ownershipEpoch) return null
    if (!talkMode.isEnabled.value && !talkMode.isListening.value && !talkMode.isSpeaking.value) {
      talkMode.ttsOnAllResponses = false
      NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
      return setExternalAudioCaptureActiveLocked(false)
    }
    return null
  }

  private fun finishTalkModeAfterRelayClose() {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        if (_voiceCaptureMode.value != VoiceCaptureMode.TalkMode) return
        talkPttCommandEpoch.incrementAndGet()
        voiceCaptureOwnershipEpoch.incrementAndGet()
        _voiceCaptureMode.value = VoiceCaptureMode.Off
        talkMode.ttsOnAllResponses = false
        NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
        setExternalAudioCaptureActiveLocked(false)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  val speakerEnabled: StateFlow<Boolean>
    get() = prefs.speakerEnabled

  val preferredCameraFacing: StateFlow<String>
    get() = prefs.preferredCameraFacing

  val preferredAudioInputDevice: StateFlow<String?>
    get() = prefs.preferredAudioInputDevice

  fun setSpeakerEnabled(value: Boolean) {
    prefs.setSpeakerEnabled(value)
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.setPlaybackEnabled(value)
    }
    // Keep TalkMode in sync so any active Talk playback also respects speaker mute.
    talkMode.setPlaybackEnabled(value)
  }

  fun setPreferredCameraFacing(value: String) {
    prefs.setPreferredCameraFacing(value)
  }

  fun setPreferredAudioInputDevice(value: String?) {
    prefs.setPreferredAudioInputDevice(value)
  }

  fun setVoiceWakeEnabled(value: Boolean) {
    if (value && !voiceWakeManager.isAvailable) return
    if (prefs.voiceWakeEnabled.value == value) return
    prefs.setVoiceWakeEnabled(value)
    voiceWakeManager.setEnabled(value)
    refreshVoiceWakeCapabilitySurfaceIfChanged()
  }

  fun setVoiceWakeWords(words: List<String>) {
    val sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)
    if (mode == NodeRuntimeMode.ScreenshotFixture) {
      prefs.setVoiceWakeWords(sanitized)
      voiceWakeManager.updateTriggerWords(sanitized)
      _voiceWakeWordsNoticeText.value = nativeText("Wake words saved")
      return
    }
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null) {
      _voiceWakeWordsNoticeText.value = nativeText("Connect to a Gateway to save wake words")
      return
    }
    if (!isVoiceWakeWordsReadyFor(gatewayScope.stableId)) {
      _voiceWakeWordsNoticeText.value = nativeText("Connect to a Gateway to save wake words")
      return
    }
    val saveSeq = voiceWakeWordsSaveSeq.incrementAndGet()
    val requestRevision = currentVoiceWakeWordsRevision()
    _voiceWakeWordsSaving.value = true
    _voiceWakeWordsNoticeText.value = null
    scope.launch {
      var published = false
      try {
        val response =
          requestGatewayData(
            gatewayScope,
            GatewayMethod.VoicewakeSet.rawValue,
            buildJsonObject {
              put("triggers", JsonArray(sanitized.map(::JsonPrimitive)))
            }.toString(),
          )
        val canonical = parseVoiceWakeWords(response) ?: error("voicewake.set returned invalid triggers")
        published =
          publishGatewayData(gatewayScope) {
            if (saveSeq == voiceWakeWordsSaveSeq.get()) {
              applyAuthoritativeVoiceWakeWords(
                words = canonical,
                gatewayStableId = gatewayScope.stableId,
                expectedRevision = requestRevision,
              )
              _voiceWakeWordsSaving.value = false
              _voiceWakeWordsNoticeText.value = nativeText("Wake words saved")
            }
          }
      } catch (_: CancellationException) {
        // Gateway-scope retirement owns state reset; never publish the old response.
      } catch (err: Throwable) {
        Log.d("OpenClawRuntime", "voicewake.set failed: ${err.message ?: err::class.java.simpleName}")
        if (saveSeq == voiceWakeWordsSaveSeq.get() && isGatewayDataScopeCurrent(gatewayScope)) {
          _voiceWakeWordsSaving.value = false
          _voiceWakeWordsNoticeText.value = nativeText("Could not save wake words")
        }
      } finally {
        if (!published && saveSeq == voiceWakeWordsSaveSeq.get() && !isGatewayDataScopeCurrent(gatewayScope)) {
          _voiceWakeWordsSaving.value = false
          _voiceWakeWordsNoticeText.value = null
        }
      }
    }
  }

  fun refreshVoiceWakePermission() {
    voiceWakeManager.refreshPermission()
    refreshVoiceWakeCapabilitySurfaceIfChanged()
  }

  private fun isVoiceWakeCapabilityEnabled(): Boolean =
    prefs.voiceWakeEnabled.value &&
      voiceWakeManager.isAvailable &&
      hasRecordAudioPermission() &&
      isVoiceWakeWordsReadyForCurrentGateway()

  private fun refreshVoiceWakeCapabilitySurfaceIfChanged() {
    val enabled = isVoiceWakeCapabilityEnabled()
    if (enabled == lastVoiceWakeCapabilityEnabled) return
    lastVoiceWakeCapabilityEnabled = enabled
    refreshNodeSurfaceAfterSettingsChange()
  }

  suspend fun runVoiceE2e(
    mode: String,
    transcript: String,
    realtimeAssistantText: String,
    timeoutMs: Long,
  ): VoiceE2eResult {
    if (!BuildConfig.DEBUG) {
      throw IllegalStateException("voice e2e is debug-only")
    }
    if (!gatewayConnectionDisplay.value.isConnected) {
      throw IllegalStateException("gateway not connected")
    }
    if (!hasRecordAudioPermission()) {
      throw IllegalStateException("microphone permission missing")
    }

    val normalizedMode = mode.trim().lowercase().ifEmpty { "both" }
    val runNormal = normalizedMode == "both" || normalizedMode == "normal" || normalizedMode == "dictation"
    val runRealtime = normalizedMode == "both" || normalizedMode == "realtime" || normalizedMode == "talk"
    if (!runNormal && !runRealtime) {
      throw IllegalArgumentException("unknown voice e2e mode: $mode")
    }

    val previousSpeakerEnabled = speakerEnabled.value
    setSpeakerEnabled(false)
    var completed = false
    return try {
      VoiceE2eResult(
        normal =
          if (runNormal) {
            runNormalVoiceE2e(transcript = transcript, timeoutMs = timeoutMs)
          } else {
            null
          },
        realtime =
          if (runRealtime) {
            runRealtimeVoiceE2e(
              transcript = transcript,
              assistantText = realtimeAssistantText,
              timeoutMs = timeoutMs,
            )
          } else {
            null
          },
      ).also { completed = true }
    } finally {
      if (!completed) {
        stopActiveVoiceSession()
      }
      setSpeakerEnabled(previousSpeakerEnabled)
    }
  }

  private suspend fun runNormalVoiceE2e(
    transcript: String,
    timeoutMs: Long,
  ): VoiceE2eSliceResult {
    stopActiveVoiceSession()
    setVoiceCaptureMode(VoiceCaptureMode.ManualMic)
    micCapture.submitTranscribedMessage(transcript)
    awaitVoiceConversation(timeoutMs = timeoutMs) {
      micCapture.conversation.value.any { it.role == VoiceConversationRole.Assistant && !it.isStreaming }
    }
    val entries = micCapture.conversation.value
    return VoiceE2eSliceResult(
      mode = "normal",
      status = micCapture.statusText.value,
      userText = entries.lastOrNull { it.role == VoiceConversationRole.User }?.text,
      assistantText = entries.lastOrNull { it.role == VoiceConversationRole.Assistant }?.text,
    )
  }

  private suspend fun runRealtimeVoiceE2e(
    transcript: String,
    assistantText: String,
    timeoutMs: Long,
  ): VoiceE2eSliceResult {
    stopActiveVoiceSession()
    setVoiceCaptureMode(VoiceCaptureMode.TalkMode)
    talkMode.runE2eRealtimeTurn(
      userText = transcript,
      assistantText = assistantText,
      timeoutMs = timeoutMs,
    )
    awaitVoiceConversation(timeoutMs = timeoutMs) {
      val entries = talkMode.conversation.value
      entries.any { it.role == VoiceConversationRole.User && !it.isStreaming } &&
        entries.any { it.role == VoiceConversationRole.Assistant && !it.isStreaming }
    }
    val entries = talkMode.conversation.value
    return VoiceE2eSliceResult(
      mode = "realtime",
      status = talkMode.statusText.value,
      userText = entries.lastOrNull { it.role == VoiceConversationRole.User }?.text,
      assistantText = entries.lastOrNull { it.role == VoiceConversationRole.Assistant }?.text,
    )
  }

  private suspend fun awaitVoiceConversation(
    timeoutMs: Long,
    ready: () -> Boolean,
  ) {
    withTimeout(timeoutMs) {
      while (!ready()) {
        delay(100L)
      }
    }
  }

  private fun setVoiceCaptureMode(
    mode: VoiceCaptureMode,
    persistManualMic: Boolean = true,
  ) {
    var startAfterSuppression: VoiceCaptureMode? = null
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        if (mode != VoiceCaptureMode.Off && (voiceNoteOwnsMic || dictationOwnsMic)) return
        if (mode != VoiceCaptureMode.Off && cameraAudioOwnsMic) return
        talkPttCommandEpoch.incrementAndGet()
        voiceCaptureOwnershipEpoch.incrementAndGet()
        val permissionDenied = mode.requiresMicrophonePermission && !hasRecordAudioPermission()
        val captureMode = if (permissionDenied) VoiceCaptureMode.Off else mode
        if (permissionDenied) prefs.setVoiceMicEnabled(false)
        if (_voiceCaptureMode.value == captureMode && isVoiceCaptureModeActive(captureMode)) return
        talkPttOwnership.set(null)
        _voiceCaptureMode.value = captureMode
        _activeAudioInputDevicePreference.value = null
        when (captureMode) {
          VoiceCaptureMode.Off -> {
            talkMode.ttsOnAllResponses = false
            talkMode.stopAllCapture()
            stopVoicePlayback()
            micCapture.setMicEnabled(false)
            if (persistManualMic) {
              prefs.setVoiceMicEnabled(false)
            }
            NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
            setExternalAudioCaptureActiveLocked(false)
          }

          VoiceCaptureMode.ManualMic -> {
            talkMode.ttsOnAllResponses = false
            talkMode.stopAllCapture()
            NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.ManualMic)
            if (persistManualMic) {
              prefs.setVoiceMicEnabled(true)
            }
            // Tapping mic on interrupts any active TTS (barge-in).
            stopVoicePlayback()
            scope.launch { talkMode.refreshConfig() }
            startAfterSuppression = VoiceCaptureMode.ManualMic
            setExternalAudioCaptureActiveLocked(true)
          }

          VoiceCaptureMode.TalkMode -> {
            if (persistManualMic) {
              prefs.setVoiceMicEnabled(false)
            }
            micCapture.setMicEnabled(false)
            NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
            talkMode.ttsOnAllResponses = true
            talkMode.setPlaybackEnabled(speakerEnabled.value)
            scope.launch { talkMode.refreshConfig() }
            talkMode.stopAllCapture()
            startAfterSuppression = VoiceCaptureMode.TalkMode
            setExternalAudioCaptureActiveLocked(true)
          }
        }
      }
    applyVoiceWakeSuppression(suppressionUpdate)
    synchronized(voiceCaptureOwnershipLock) {
      when (startAfterSuppression) {
        VoiceCaptureMode.ManualMic -> {
          if (_voiceCaptureMode.value == VoiceCaptureMode.ManualMic && externalAudioCaptureActive.value) {
            micCapture.setMicEnabled(true)
          }
        }
        VoiceCaptureMode.TalkMode -> {
          if (_voiceCaptureMode.value == VoiceCaptureMode.TalkMode && externalAudioCaptureActive.value) {
            talkMode.setEnabled(true)
          }
        }
        VoiceCaptureMode.Off,
        null,
        -> Unit
      }
    }
  }

  private fun stopManualVoiceSession() {
    if (_voiceCaptureMode.value != VoiceCaptureMode.ManualMic) return
    setVoiceCaptureMode(VoiceCaptureMode.Off)
  }

  private fun stopActiveVoiceSession() {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        talkPttCommandEpoch.incrementAndGet()
        voiceCaptureOwnershipEpoch.incrementAndGet()
        talkPttOwnership.set(null)
        talkMode.ttsOnAllResponses = false
        talkMode.stopAllCapture()
        stopVoicePlayback()
        micCapture.setMicEnabled(false)
        prefs.setVoiceMicEnabled(false)
        NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
        _voiceCaptureMode.value = VoiceCaptureMode.Off
        setExternalAudioCaptureActiveLocked(false)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  private fun setExternalAudioCaptureActiveLocked(active: Boolean): VoiceWakeSuppressionUpdate {
    externalAudioCaptureActive.value = active
    return createVoiceCaptureSuppressionUpdateLocked()
  }

  internal fun setCameraAudioCaptureActive(active: Boolean): Boolean {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        if (active) {
          if (
            cameraAudioOwnsMic ||
            voiceNoteOwnsMic ||
            dictationOwnsMic ||
            !isVoiceCaptureModeActive(VoiceCaptureMode.Off)
          ) {
            return false
          }
          cameraAudioOwnsMic = true
        } else {
          cameraAudioOwnsMic = false
        }
        createVoiceWakeSuppressionUpdateLocked(VoiceWakeSuppressionReason.Camera, active)
      }
    applyVoiceWakeSuppression(suppressionUpdate)
    return true
  }

  private fun acquireVoiceReplySpeechSuppression() {
    if (voiceReplySpeechDepth.incrementAndGet() == 1) {
      voiceWakeManager.setSuppressed(VoiceWakeSuppressionReason.VoiceReplySpeech, true)
    }
  }

  private fun releaseVoiceReplySpeechSuppression() {
    while (true) {
      val depth = voiceReplySpeechDepth.get()
      if (depth == 0) return
      if (!voiceReplySpeechDepth.compareAndSet(depth, depth - 1)) continue
      if (depth == 1) {
        voiceWakeManager.setSuppressed(VoiceWakeSuppressionReason.VoiceReplySpeech, false)
      }
      return
    }
  }

  private fun reconcileVoiceWakeCaptureSuppression() {
    val suppressionUpdate =
      synchronized(voiceCaptureOwnershipLock) {
        createVoiceCaptureSuppressionUpdateLocked()
      }
    applyVoiceWakeSuppression(suppressionUpdate)
  }

  private fun createVoiceCaptureSuppressionUpdateLocked(): VoiceWakeSuppressionUpdate =
    createVoiceWakeSuppressionUpdateLocked(
      reason = VoiceWakeSuppressionReason.VoiceCapture,
      suppressed = externalAudioCaptureActive.value || micCapture.micCooldown.value,
    )

  private fun createVoiceWakeSuppressionUpdateLocked(
    reason: VoiceWakeSuppressionReason,
    suppressed: Boolean,
  ): VoiceWakeSuppressionUpdate {
    voiceWakeSuppressionRevision += 1
    return VoiceWakeSuppressionUpdate(
      reason = reason,
      suppressed = suppressed,
      revision = voiceWakeSuppressionRevision,
    )
  }

  private fun applyVoiceWakeSuppression(update: VoiceWakeSuppressionUpdate?) {
    if (update == null) return
    // Versioned application happens after ownership unlock. This avoids a main
    // looper lock inversion while preventing an older release from winning.
    voiceWakeManager.setSuppressed(
      reason = update.reason,
      suppressed = update.suppressed,
      revision = update.revision,
    )
  }

  private fun stopVoicePlayback() {
    talkMode.stopTts()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.stopTts()
    }
  }

  private val VoiceCaptureMode.requiresMicrophonePermission: Boolean
    get() = this == VoiceCaptureMode.ManualMic || this == VoiceCaptureMode.TalkMode

  private fun isVoiceCaptureModeActive(mode: VoiceCaptureMode): Boolean =
    when (mode) {
      VoiceCaptureMode.Off ->
        !cameraAudioOwnsMic &&
          !externalAudioCaptureActive.value &&
          !micCapture.micEnabled.value &&
          !micCapture.micCooldown.value &&
          !talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
      VoiceCaptureMode.ManualMic ->
        externalAudioCaptureActive.value &&
          micCapture.micEnabled.value &&
          !talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
      VoiceCaptureMode.TalkMode ->
        externalAudioCaptureActive.value &&
          !micCapture.micEnabled.value &&
          talkMode.isEnabled.value &&
          talkMode.activePushToTalkCaptureId == null
    }

  fun refreshGatewayConnection() {
    preferredGatewayReconnectSuppressed = false
    secondaryGatewayConnectionsEnabled.value = true
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      val endpoint = connectedEndpoint
      if (endpoint == null) {
        val preferred = resolvePreferredGatewayEndpoint()
        if (preferred == null) {
          setStandaloneGatewayStatus("Failed: no saved gateway endpoint")
        } else {
          prepareGatewayTarget(preferred)
          beginConnect(preferred, resolveGatewayConnectAuth(preferred))
        }
        return@launchGatewayLifecycle
      }
      updateStatus {
        operatorStatusText = "Connecting…"
        operatorConnectionProblem = null
      }
      connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint), reconnect = true)
    }
  }

  private fun refreshNodeSurfaceAfterSettingsChange() {
    launchGatewayLifecycle {
      if (preferredGatewayReconnectSuppressed) return@launchGatewayLifecycle
      val endpoint = connectedEndpoint ?: return@launchGatewayLifecycle
      connectWithAuth(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint), reconnect = true)
    }
  }

  private fun launchGatewayLifecycle(block: () -> Unit) {
    val intent = gatewayLifecycleIntentSeq.get()
    val guardedBlock = {
      synchronized(gatewayLifecycleIntentLock) {
        if (intent == gatewayLifecycleIntentSeq.get()) block()
      }
    }
    if (gatewaySwitchMutex.tryLock()) {
      try {
        guardedBlock()
      } finally {
        gatewaySwitchMutex.unlock()
      }
    } else {
      scope.launch { gatewaySwitchMutex.withLock { guardedBlock() } }
    }
  }

  private fun connectWithAuth(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    reconnect: Boolean = false,
    beforeConnect: () -> Unit = {},
  ): Boolean =
    runGatewayConnectOperation {
      beforeConnect()
      activeGatewayAuth = auth
      val tls = connectionManager.resolveTlsParams(endpoint)
      val storedOperatorEntry = loadStoredRoleDeviceAuthEntry(endpoint, "operator")
      refreshGatewayControlPage(endpoint, auth, storedOperatorEntry?.token)
      val usesStoredOperatorDeviceToken =
        operatorSessionUsesStoredDeviceToken(auth, storedOperatorEntry?.token)
      val operatorAuth =
        resolveOperatorSessionConnectAuth(
          auth = auth,
          storedOperatorToken = storedOperatorEntry?.token,
        )
      if (operatorAuth == null) {
        updateStatus {
          operatorConnected = false
          operatorStatusText = "Offline"
          operatorConnectionProblem = null
        }
        operatorSession.disconnect()
      } else {
        operatorSession.connect(
          endpoint,
          operatorAuth.token,
          operatorAuth.bootstrapToken,
          operatorAuth.password,
          connectionManager.buildOperatorConnectOptions(
            scopes =
              operatorConnectScopesForAuth(
                usesStoredDeviceToken = usesStoredOperatorDeviceToken,
                storedOperatorScopes = storedOperatorEntry?.scopes,
              ),
          ),
          tls,
        )
      }
      nodeSession.connect(
        endpoint,
        auth.token,
        auth.bootstrapToken,
        auth.password,
        connectionManager.buildNodeConnectOptions(),
        tls,
      )
      if (reconnect && operatorAuth != null) {
        operatorSession.reconnect()
      }
      if (reconnect) {
        nodeSession.reconnect()
      }
    }

  // Auth reset waits for claimed connection starts before disconnecting. Session calls stay outside
  // this monitor because GatewaySession invokes callbacks while holding its own lifecycle monitor.
  private fun runGatewayConnectOperation(block: () -> Unit): Boolean {
    val claimed =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          false
        } else {
          if (gatewayConnectOperationsInFlight == 0) {
            gatewayConnectOperationsDrained = CompletableDeferred()
          }
          gatewayConnectOperationsInFlight += 1
          true
        }
      }
    if (!claimed) return false
    try {
      block()
      return true
    } finally {
      val drained =
        synchronized(gatewayAuthLifecycleLock) {
          gatewayConnectOperationsInFlight -= 1
          gatewayConnectOperationsDrained.takeIf { gatewayConnectOperationsInFlight == 0 }
        }
      drained?.complete(Unit)
    }
  }

  private fun beginConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    synchronized(gatewayAuthLifecycleLock) {
      if (gatewayAuthResetInProgress) return
    }
    // A user-selected connect target must never inherit notification content from another gateway.
    if (gatewayDefaultAgentStableId?.let { it != endpoint.stableId } == true) {
      updateGatewayDefaultAgentId(null)
    }
    notificationOutbox.clear()
    invalidateNodeCapabilityApprovalState()
    val connectAttemptId = connectAttemptSeq.incrementAndGet()
    connectingEndpointStableId = endpoint.stableId
    chat.onGatewayScopeChanging()
    _pendingGatewayTrust.value = null
    val tls = connectionManager.resolveTlsParams(endpoint)
    if (tls?.required == true) {
      val storedFingerprint = tls.expectedFingerprint
      setStandaloneGatewayStatus("Verify gateway TLS fingerprint…")
      scope.launch {
        val tlsProbe = tlsFingerprintProbe(endpoint.host, endpoint.port)
        if (!isCurrentConnectAttempt(connectAttemptId)) return@launch
        when (
          val decision =
            decideGatewayTlsTrust(
              storedFingerprint = storedFingerprint,
              systemTrustCandidate = isGatewayTlsSystemTrustCandidate(endpoint.host),
              probeResult = tlsProbe,
            )
        ) {
          GatewayTlsTrustDecision.SystemTrusted -> {
            // Automatic platform trust only applies where no user-accepted pin exists.
            // Replacing a pin always requires explicit confirmation in the trust prompt.
            registerGateway(endpoint, setActive = true)
            connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
          }
          is GatewayTlsTrustDecision.PinnedTrust ->
            connectAfterTlsCheck(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
          is GatewayTlsTrustDecision.PromptRequired -> {
            decision.probeFailure?.let { setStandaloneGatewayStatus(gatewayTlsProbeFailureMessage(it)) }
            publishGatewayTrustPromptIfCurrent(
              connectAttemptId = connectAttemptId,
              prompt =
                GatewayTrustPrompt(
                  endpoint = endpoint,
                  fingerprintSha256 = decision.fingerprintSha256,
                  auth = auth,
                  previousFingerprintSha256 = decision.previousFingerprintSha256,
                  probeFailure = decision.probeFailure,
                  systemTrustAvailable = decision.systemTrustAvailable,
                ),
            )
          }
          is GatewayTlsTrustDecision.Failed -> {
            connectingEndpointStableId = null
            setStandaloneGatewayStatus(gatewayTlsProbeFailureMessage(decision.reason))
          }
        }
      }
      return
    }

    connectAfterTlsCheckLocked(endpoint = endpoint, auth = auth, connectAttemptId = connectAttemptId)
  }

  private fun isCurrentConnectAttempt(connectAttemptId: Long): Boolean = connectAttemptSeq.get() == connectAttemptId

  private fun publishGatewayTrustPromptIfCurrent(
    connectAttemptId: Long,
    prompt: GatewayTrustPrompt,
  ): Boolean =
    synchronized(gatewayAuthLifecycleLock) {
      if (gatewayAuthResetInProgress || !isCurrentConnectAttempt(connectAttemptId)) {
        false
      } else {
        _pendingGatewayTrust.value = prompt
        true
      }
    }

  private fun refreshGatewayControlPage(
    endpoint: GatewayEndpoint? = connectedEndpoint,
    auth: GatewayConnectAuth? = activeGatewayAuth,
    storedOperatorToken: String? = endpoint?.let { loadStoredRoleDeviceAuthEntry(it, "operator")?.token },
  ) {
    if (endpoint == null) {
      _gatewayControlPage.value = null
      return
    }
    val pageAuth = resolveGatewayControlPageAuth(auth ?: resolveGatewayConnectAuth(endpoint), storedOperatorToken)
    _gatewayControlPage.value =
      GatewayControlPage(
        baseUrl = gatewayControlPageBaseUrl(endpoint),
        token = pageAuth.token,
        password = pageAuth.password,
      )
  }

  private fun connectAfterTlsCheck(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    connectAttemptId: Long,
  ) {
    launchGatewayLifecycle { connectAfterTlsCheckLocked(endpoint, auth, connectAttemptId) }
  }

  private fun connectAfterTlsCheckLocked(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
    connectAttemptId: Long,
  ) {
    if (!isCurrentConnectAttempt(connectAttemptId)) return
    connectWithAuth(endpoint = endpoint, auth = auth) {
      connectedEndpoint = endpoint
      connectingEndpointStableId = null
      updateStatus {
        operatorConnectionProblem = null
        nodeConnectionProblem = null
        operatorStatusText = "Connecting…"
        nodeStatusText = "Connecting…"
      }
    }
  }

  fun connect(endpoint: GatewayEndpoint) {
    preferredGatewayReconnectSuppressed = false
    secondaryGatewayConnectionsEnabled.value = true
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchConnect(endpoint, explicitAuth = null)
  }

  fun connect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    preferredGatewayReconnectSuppressed = false
    secondaryGatewayConnectionsEnabled.value = true
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchConnect(endpoint, explicitAuth = auth)
  }

  private fun launchConnect(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth?,
  ) {
    launchGatewayLifecycle {
      prepareGatewayTarget(endpoint)
      beginConnect(endpoint = endpoint, auth = resolveGatewayConnectAuth(endpoint, explicitAuth))
    }
  }

  private fun prepareGatewayTarget(endpoint: GatewayEndpoint) {
    if (connectedEndpoint?.stableId?.let { it != endpoint.stableId } == true) {
      // Closing both sockets is synchronous; cleanup callbacks may finish later, but no event can
      // cross the active-pointer change on the old authenticated transport.
      disconnect(retireRunState = true)
    }
    if (prefs.gatewayRegistry.entries.value
        .any { it.stableId == endpoint.stableId }
    ) {
      prefs.gatewayRegistry.setActive(endpoint.stableId)
    }
  }

  /** HTTP(S) origin serving the connected gateway's Control UI pages. */
  private fun gatewayControlPageBaseUrl(endpoint: GatewayEndpoint): String {
    val scheme = if (endpoint.tlsEnabled) "https" else "http"
    return "$scheme://${formatGatewayAuthority(endpoint.host, endpoint.port)}"
  }

  internal fun resolveGatewayConnectAuth(
    endpoint: GatewayEndpoint,
    explicitAuth: GatewayConnectAuth? = null,
  ): GatewayConnectAuth =
    explicitAuth
      ?: prefs.loadGatewayCredentials(endpoint.stableId).let { credentials ->
        GatewayConnectAuth(
          token = credentials.token,
          bootstrapToken = credentials.bootstrapToken,
          password = credentials.password,
        )
      }

  fun acceptGatewayTrustPrompt(manualFingerprint: String? = null) {
    val prompt = _pendingGatewayTrust.value ?: return
    val acceptedFingerprint =
      normalizeGatewayTlsFingerprintInput(
        prompt.fingerprintSha256 ?: manualFingerprint ?: return,
      ) ?: return
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      if (_pendingGatewayTrust.value != prompt) return@launchGatewayLifecycle
      _pendingGatewayTrust.value = null
      prefs.saveGatewayTlsFingerprint(prompt.endpoint.stableId, acceptedFingerprint)
      registerGateway(prompt.endpoint, setActive = true)
      beginConnect(endpoint = prompt.endpoint, auth = prompt.auth)
    }
  }

  fun useSystemGatewayTrustPrompt() {
    val prompt = _pendingGatewayTrust.value ?: return
    if (!prompt.systemTrustAvailable) return
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      if (_pendingGatewayTrust.value != prompt) return@launchGatewayLifecycle
      _pendingGatewayTrust.value = null
      prefs.clearGatewayTlsFingerprint(prompt.endpoint.stableId)
      registerGateway(prompt.endpoint, setActive = true)
      beginConnect(endpoint = prompt.endpoint, auth = prompt.auth)
    }
  }

  fun declineGatewayTrustPrompt() {
    gatewayLifecycleIntentSeq.incrementAndGet()
    launchGatewayLifecycle {
      _pendingGatewayTrust.value = null
      connectingEndpointStableId = null
      setStandaloneGatewayStatus("Offline")
    }
  }

  private fun gatewayTlsProbeFailureMessage(failure: GatewayTlsProbeFailure): String =
    when (failure) {
      GatewayTlsProbeFailure.TLS_UNAVAILABLE ->
        nativeText(
          "Failed: no secure gateway endpoint was detected. Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address with Unencrypted selected.",
        ).source
      GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT ->
        nativeText(
          "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry.",
        ).source
      GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE ->
        nativeText("Failed: couldn't reach the secure gateway endpoint for this host.").source
    }

  private fun hasRecordAudioPermission(): Boolean =
    (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    )

  fun connectManual() {
    val host = manualHost.value.trim()
    val port = manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      setStandaloneGatewayStatus("Failed: invalid manual host/port")
      return
    }
    connect(GatewayEndpoint.manual(host = host, port = port))
  }

  private fun loadStoredRoleDeviceAuthEntry(
    endpoint: GatewayEndpoint,
    role: String,
  ): DeviceAuthEntry? {
    val deviceId = identityStore.loadOrCreate().deviceId
    return deviceAuthStore.loadEntry(endpoint.stableId, deviceId, role)
  }

  private fun maybeStartOperatorSessionAfterNodeConnect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    val selectedGatewayId = connectedEndpoint?.stableId ?: connectingEndpointStableId
    if (selectedGatewayId != null && selectedGatewayId != endpoint.stableId) return
    runGatewayConnectOperation {
      if (operatorConnected) return@runGatewayConnectOperation
      val storedOperatorEntry = loadStoredRoleDeviceAuthEntry(endpoint, "operator")
      val usesStoredOperatorDeviceToken =
        operatorSessionUsesStoredDeviceToken(auth, storedOperatorEntry?.token)
      val operatorAuth =
        resolveOperatorSessionConnectAuth(
          auth = auth,
          storedOperatorToken = storedOperatorEntry?.token,
        ) ?: return@runGatewayConnectOperation
      updateStatus {
        operatorStatusText = "Connecting…"
        operatorConnectionProblem = null
      }
      operatorSession.connect(
        endpoint,
        operatorAuth.token,
        operatorAuth.bootstrapToken,
        operatorAuth.password,
        connectionManager.buildOperatorConnectOptions(
          scopes =
            operatorConnectScopesForAuth(
              usesStoredDeviceToken = usesStoredOperatorDeviceToken,
              storedOperatorScopes = storedOperatorEntry?.scopes,
            ),
        ),
        connectionManager.resolveTlsParams(endpoint),
      )
    }
  }

  fun disconnect() {
    synchronized(gatewayLifecycleIntentLock) {
      preferredGatewayReconnectSuppressed = true
      secondaryGatewayConnectionsEnabled.value = false
      gatewayLifecycleIntentSeq.incrementAndGet()
      disconnectSecondaryGatewayConnections()
      disconnect(retireRunState = false)
    }
  }

  fun prepareForGatewaySetup() {
    synchronized(gatewayLifecycleIntentLock) {
      preferredGatewayReconnectSuppressed = true
      secondaryGatewayConnectionsEnabled.value = false
      gatewayLifecycleIntentSeq.incrementAndGet()
      disconnectSecondaryGatewayConnections()
      disconnect(retireRunState = true)
    }
  }

  private fun disconnectSecondaryGatewayConnections() {
    val sessions = secondaryOperatorSessions.values.map { it.session }
    secondaryOperatorSessions.clear()
    _backgroundGatewayStatuses.value = emptyMap()
    sessions.forEach { it.disconnect() }
  }

  private fun disconnect(retireRunState: Boolean) {
    if (wearRealtimeTalkControllerLazy.isInitialized()) wearRealtimeTalkController.abort()
    prepareDisconnect(retireRunState)
    operatorSession.disconnect()
    nodeSession.disconnect()
  }

  suspend fun forgetGateway(stableId: String): Boolean =
    gatewayLifecycleIntentSeq.incrementAndGet().let { intent ->
      gatewaySwitchMutex.withLock {
        if (intent != gatewayLifecycleIntentSeq.get()) false else forgetGatewayLocked(stableId)
      }
    }

  private suspend fun forgetGatewayLocked(stableId: String): Boolean {
    val normalized = stableId.trim()
    if (normalized.isEmpty()) return false
    secondaryOperatorSessions.remove(normalized)?.session?.disconnectAndJoin()
    updateBackgroundGatewayStatus(normalized, null)
    val wasActive = prefs.gatewayRegistry.activeStableId.value == normalized
    val connectOperationsDrained =
      synchronized(gatewayAuthLifecycleLock) {
        if (gatewayAuthResetInProgress) {
          null
        } else {
          gatewayAuthResetInProgress = true
          gatewayConnectOperationsDrained
        }
      }
        ?: return false
    return try {
      connectOperationsDrained.await()
      if (connectedEndpoint?.stableId == normalized) {
        disconnectAndJoin()
      } else if (connectingEndpointStableId == normalized) {
        connectAttemptSeq.incrementAndGet()
        connectingEndpointStableId = null
        _pendingGatewayTrust.value = null
        chat.onGatewayScopeChanging(retireRunState = true)
      } else if (wasActive) {
        prepareDisconnect(retireRunState = true)
      }
      drainIdleGatewaySessionTails()
      val removalStaged =
        runCatching { clientDatabases.stageGatewayRemoval(normalized) }
          .onFailure { err ->
            Log.e("OpenClawRuntime", "Failed to stage forgotten gateway data removal", err)
            setStandaloneGatewayStatus("Failed: couldn't prepare offline gateway cleanup. Retry forget.")
          }.isSuccess
      if (!removalStaged) return false
      val authRetired =
        runCatching {
          val deviceId = identityStore.loadOrCreate().deviceId
          deviceAuthStore.clearToken(normalized, deviceId, "node")
          deviceAuthStore.clearToken(normalized, deviceId, "operator")
          prefs.clearGatewayCredentials(normalized)
          prefs.clearGatewayCustomHeaders(normalized)
          prefs.clearGatewayTlsFingerprint(normalized)
          prefs.clearNotificationForwardingSessionKey(normalized)
        }.onFailure { err ->
          runCatching { clientDatabases.cancelGatewayRemoval(normalized) }
          Log.e("OpenClawRuntime", "Failed to retire forgotten gateway authentication", err)
          setStandaloneGatewayStatus("Failed: couldn't clear saved gateway authentication. Retry forget.")
        }.isSuccess
      if (!authRetired) return false
      val cacheCleared =
        runCatching {
          chat.clearGatewayCache(normalized) {
            clientDatabases.commitGatewayRemoval(normalized, requireCacheRemoval = true)
            externalTranscriptCache?.clearGateway(normalized)
          }
        }.onFailure { err ->
          Log.e("OpenClawRuntime", "Failed to purge forgotten gateway chat data", err)
          setStandaloneGatewayStatus("Failed: couldn't clear offline gateway data. Retry forget.")
        }.isSuccess
      if (!cacheCleared) return false
      // Publish registry removal only after auth, durable state, and transcripts are gone. Any
      // earlier failure leaves this signed-out registration available for an idempotent retry.
      val registryRemoved =
        runCatching {
          check(prefs.gatewayRegistry.remove(normalized)) { "Failed to persist gateway registry removal" }
        }.fold(
          onSuccess = { true },
          onFailure = { err ->
            runCatching { clientDatabases.cancelGatewayRemoval(normalized) }
            Log.e("OpenClawRuntime", "Failed to commit forgotten gateway registry removal", err)
            setStandaloneGatewayStatus("Failed: couldn't remove the saved gateway. Retry forget.")
            false
          },
        )
      if (!registryRemoved) return false
      true
    } finally {
      synchronized(gatewayAuthLifecycleLock) { gatewayAuthResetInProgress = false }
    }
  }

  private fun recordConnectedGateway() {
    val endpoint = connectedEndpoint ?: return
    registerGateway(endpoint, setActive = true)
    prefs.gatewayRegistry.markConnected(endpoint.stableId, System.currentTimeMillis())
  }

  private fun registerGateway(
    endpoint: GatewayEndpoint,
    setActive: Boolean,
  ) {
    val existing =
      prefs.gatewayRegistry.entries.value
        .firstOrNull { it.stableId == endpoint.stableId }
    val entry =
      if (endpoint.stableId.startsWith("manual|")) {
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = endpoint.name,
          host = endpoint.host,
          port = endpoint.port,
          tls = existing?.tls ?: manualTls.value,
          lastConnectedAtMs = existing?.lastConnectedAtMs ?: 0L,
        )
      } else {
        GatewayRegistryEntry(
          stableId = endpoint.stableId,
          kind = GatewayRegistryEntryKind.DISCOVERED,
          name = endpoint.name,
          tls = true,
          lastConnectedAtMs = existing?.lastConnectedAtMs ?: 0L,
        )
      }
    prefs.gatewayRegistry.upsert(entry)
    if (setActive) prefs.gatewayRegistry.setActive(endpoint.stableId)
  }

  private suspend fun disconnectAndJoin() {
    prepareDisconnect(retireRunState = true)
    // Both sockets close before either reconnect loop is joined, so no authenticated role stays
    // live while reset waits for the other role's terminal callback.
    coroutineScope {
      launch { operatorSession.disconnectAndJoin() }
      launch { nodeSession.disconnectAndJoin() }
    }
  }

  private suspend fun drainIdleGatewaySessionTails() {
    if (connectedEndpoint != null || connectingEndpointStableId != null) return
    coroutineScope {
      launch { operatorSession.disconnectAndJoin() }
      launch { nodeSession.disconnectAndJoin() }
    }
  }

  private fun prepareDisconnect(retireRunState: Boolean) {
    notificationOutbox.clear()
    connectAttemptSeq.incrementAndGet()
    synchronized(gatewayDataScopeLock) {
      gatewayDataGeneration += 1
      clearOperatorGatewayState(retirePendingCronRuns = true)
    }
    if (retireRunState) updateGatewayDefaultAgentId(null)
    invalidateVoiceWakeWordsForGateway()
    chat.onGatewayScopeChanging(retireRunState)
    stopMessageSpeech()
    micCapture.onGatewayScopeChanging()
    stopActiveVoiceSession()
    talkMode.onGatewayScopeChanging()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.onGatewayScopeChanging()
    }
    if (retireRunState) {
      val defaultMainSessionKey = resolveNodeMainSessionKey()
      _mainSessionKey.value = defaultMainSessionKey
      talkMode.setMainSessionKey(defaultMainSessionKey)
    }
    connectedEndpoint = null
    connectingEndpointStableId = null
    _gatewayControlPage.value = null
    activeGatewayAuth = null
    updateStatus {
      operatorConnected = false
      _nodeConnected.value = false
      operatorStatusText = "Offline"
      nodeStatusText = "Offline"
      operatorConnectionProblem = null
      nodeConnectionProblem = null
    }
    _pendingGatewayTrust.value = null
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    val gatewayId = connectedEndpoint?.stableId
    scope.launch {
      val trimmed = payloadJson.trim()
      if (trimmed.isEmpty()) return@launch

      val root =
        try {
          json.parseToJsonElement(trimmed).asObjectOrNull() ?: return@launch
        } catch (_: Throwable) {
          return@launch
        }

      val userActionObj = (root["userAction"] as? JsonObject) ?: root
      val actionId =
        (userActionObj["id"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty {
          java.util.UUID
            .randomUUID()
            .toString()
        }
      val name = OpenClawCanvasA2UIAction.extractActionName(userActionObj) ?: return@launch

      val surfaceId =
        (userActionObj["surfaceId"] as? JsonPrimitive)
          ?.content
          ?.trim()
          .orEmpty()
          .ifEmpty { "main" }
      val sourceComponentId =
        (userActionObj["sourceComponentId"] as? JsonPrimitive)
          ?.content
          ?.trim()
          .orEmpty()
          .ifEmpty { "-" }
      val contextJson = (userActionObj["context"] as? JsonObject)?.toString()

      val sessionKey = resolveMainSessionKey()
      val message =
        OpenClawCanvasA2UIAction.formatAgentMessage(
          actionName = name,
          sessionKey = sessionKey,
          surfaceId = surfaceId,
          sourceComponentId = sourceComponentId,
          host = displayName.value,
          instanceId = instanceId.value.lowercase(),
          contextJson = contextJson,
        )

      val connected = _nodeConnected.value
      var error: String? = null
      if (connected && gatewayId != null) {
        val sent =
          nodeSession.sendNodeEventForEndpoint(
            expectedEndpointStableId = gatewayId,
            event = "agent.request",
            payloadJson =
              buildJsonObject {
                put("message", JsonPrimitive(message))
                put("sessionKey", JsonPrimitive(sessionKey))
                put("thinking", JsonPrimitive("low"))
                put("deliver", JsonPrimitive(false))
                put("key", JsonPrimitive(actionId))
              }.toString(),
          )
        if (!sent) {
          error = "send failed"
        }
      } else {
        error = "gateway not connected"
      }

      try {
        canvas.eval(
          OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
            actionId = actionId,
            ok = connected && error == null,
            error = error,
          ),
        )
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean = a2uiHandler.isTrustedCanvasActionUrl(rawUrl)

  internal suspend fun resolveInlineWidgetResource(
    path: String,
    failedResource: ChatWidgetResource?,
  ): ChatWidgetResource? {
    fun GatewaySession.currentWidgetSurface(): ChatWidgetSurface? =
      currentCanvasHostRoute()?.let { route ->
        ChatWidgetSurface(
          url = route.url,
          tlsFingerprintSha256 = route.tlsFingerprintSha256,
        )
      }

    fun currentSurfaceUrls(): ChatWidgetSurfaceUrls =
      ChatWidgetSurfaceUrls(
        node = nodeSession.currentWidgetSurface(),
        operator = operatorSession.currentWidgetSurface(),
      )

    // Initial loads may use the operator fallback; failures rotate the preferred live route.
    if (failedResource == null) return ChatWidgetUrlResolver.resolvePreferred(currentSurfaceUrls(), path, excluding = null)
    return inlineWidgetRefreshMutex.withLock {
      // Serialize both role sessions so sibling widgets cannot invalidate each other's new token.
      ChatWidgetUrlResolver.resolveAfterFailure(
        target = path,
        failedResource = failedResource,
        currentSurfaceUrls = ::currentSurfaceUrls,
        refreshNodeSurface = { observedUrl ->
          nodeSession.refreshCanvasHostRouteIfCurrent(observedUrl)?.let { route ->
            ChatWidgetSurface(
              url = route.url,
              tlsFingerprintSha256 = route.tlsFingerprintSha256,
            )
          }
        },
        refreshOperatorSurface = { observedUrl ->
          operatorSession.refreshCanvasHostRouteIfCurrent(observedUrl)?.let { route ->
            ChatWidgetSurface(
              url = route.url,
              tlsFingerprintSha256 = route.tlsFingerprintSha256,
            )
          }
        },
      )
    }
  }

  fun loadChat(
    sessionKey: String,
    ownerAgentId: String? = null,
  ) {
    val key = sessionKey.trim().ifEmpty { resolveMainSessionKey() }
    chat.load(key, ownerAgentId)
  }

  fun refreshChat() {
    chat.refresh()
  }

  fun refreshChatSessions(
    limit: Int? = null,
    archived: Boolean = false,
  ) {
    chat.refreshSessions(limit = limit, archived = archived)
  }

  suspend fun patchChatSession(
    key: String,
    ownerAgentId: String? = null,
    label: String? = null,
    clearLabel: Boolean = false,
    category: String? = null,
    clearCategory: Boolean = false,
    pinned: Boolean? = null,
    archived: Boolean? = null,
    unread: Boolean? = null,
  ) {
    chat.patchSession(
      key = key,
      ownerAgentId = ownerAgentId,
      label = label,
      clearLabel = clearLabel,
      category = category,
      clearCategory = clearCategory,
      pinned = pinned,
      archived = archived,
      unread = unread,
    )
  }

  suspend fun renameChatSessionGroup(
    from: String,
    to: String,
  ) {
    chat.renameSessionGroup(from = from, to = to)
  }

  suspend fun dissolveChatSessionGroup(group: String) {
    chat.dissolveSessionGroup(group)
  }

  internal suspend fun deleteChatSession(
    key: String,
    ownerAgentId: String?,
  ): ChatSessionDeletion? = chat.deleteSession(key, ownerAgentId)

  suspend fun forkChatSession(
    parentKey: String,
    ownerAgentId: String? = null,
  ): String? = chat.forkSession(parentKey, ownerAgentId)

  fun setChatThinkingLevel(level: String) {
    chat.setThinkingLevel(level)
  }

  fun setChatSessionModel(
    sessionKey: String,
    modelRef: String?,
  ) {
    chat.setSessionModel(sessionKey = sessionKey, modelRef = modelRef)
  }

  fun switchChatSession(
    sessionKey: String,
    ownerAgentId: String? = null,
  ) {
    stopMessageSpeech()
    chat.switchSession(sessionKey, ownerAgentId)
  }

  fun selectChatAgent(agentId: String) {
    val normalizedAgentId = agentId.trim()
    if (normalizedAgentId.isEmpty()) return
    stopMessageSpeech()
    // Agent selection owns every main-session consumer; switching chat alone would
    // leave Talk mode and the home canvas bound to the previous agent.
    selectedChatAgentId = normalizedAgentId
    selectMainSessionKey(normalizedAgentId)
  }

  suspend fun fetchChatSessionList(
    search: String?,
    archived: Boolean,
  ): List<ChatSessionEntry> = chat.fetchSessionList(search = search, archived = archived)

  fun abortChat() {
    chat.abort()
  }

  fun startNewChat(worktree: Boolean = false) {
    stopMessageSpeech()
    chat.startNewChat(worktree = worktree)
  }

  fun toggleMessageSpeech(
    messageId: String,
    text: String,
  ) {
    messageSpeechController.toggle(messageId = messageId, text = text)
  }

  fun stopMessageSpeech() {
    if (messageSpeechControllerLazy.isInitialized()) messageSpeechController.stop()
  }

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ) {
    chat.sendMessage(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  suspend fun sendChatAwaitAcceptance(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean = chat.sendMessageAwaitAcceptance(message = message, thinkingLevel = thinking, attachments = attachments)

  internal fun canSendForOwner(owner: ChatComposerOwner): Boolean = chat.canSendForOwner(owner)

  internal suspend fun sendChatForOwnerAwaitAcceptance(
    owner: ChatComposerOwner,
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
    idempotencyKey: String,
  ): Boolean =
    chat.sendMessageForOwnerAwaitAcceptance(
      message = message,
      thinkingLevel = thinking,
      attachments = attachments,
      expectedOwner = owner,
      idempotencyKey = idempotencyKey,
    )

  internal suspend fun wasChatOutboxCommandAdmitted(id: String): Boolean = chat.wasOutboxCommandAdmitted(id)

  fun refreshChatCommands() {
    chat.refreshCommands()
  }

  private fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event == "update.available") {
      _gatewayUpdateAvailable.value = parseGatewayUpdateAvailable(payloadJson)
    }
    if (event == GatewayEvent.VoicewakeChanged.rawValue) {
      applyVoiceWakeWords(payloadJson)
    }
    handleExecApprovalGatewayEvent(event = event, payloadJson = payloadJson)
    micCapture.handleGatewayEvent(event, payloadJson)
    talkMode.handleGatewayEvent(event, payloadJson)
    if (wearRealtimeTalkControllerLazy.isInitialized()) {
      wearRealtimeTalkController.handleGatewayEvent(event, payloadJson)
    }
    chat.handleGatewayEvent(event, payloadJson)
    if (event == "chat" && !payloadJson.isNullOrBlank()) {
      runCatching { json.parseToJsonElement(payloadJson) }
        .getOrNull()
        ?.let { wearProxyBridge()?.publishChat(it) }
    }
  }

  private fun handleNodeGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    if (event != GatewayEvent.VoicewakeChanged.rawValue) return
    val endpointStableId = nodeSession.currentEndpointStableId() ?: return
    applyNodeVoiceWakeWords(endpointStableId, payloadJson) {
      nodeSession.currentEndpointStableId() == endpointStableId
    }
  }

  internal fun applyNodeVoiceWakeWords(
    endpointStableId: String,
    payloadJson: String?,
    isCurrentConnection: () -> Boolean,
  ) {
    val gatewayScope = captureGatewayDataScope()?.takeIf { it.stableId == endpointStableId } ?: return
    val words = parseVoiceWakeWords(payloadJson) ?: return
    var applied = false
    publishGatewayData(gatewayScope) {
      if (isCurrentConnection()) {
        applied = applyAuthoritativeVoiceWakeWords(words, gatewayStableId = gatewayScope.stableId)
      }
    }
    if (applied) resumeVoiceWakeAfterGatewayWords(gatewayScope)
  }

  private suspend fun refreshWakeWordsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    val requestRevision = currentVoiceWakeWordsRevision()
    try {
      val words = parseVoiceWakeWords(requestGatewayData(gatewayScope, GatewayMethod.VoicewakeGet.rawValue, "{}")) ?: return
      var applied = false
      publishGatewayData(gatewayScope) {
        applied =
          applyAuthoritativeVoiceWakeWords(
            words = words,
            gatewayStableId = gatewayScope.stableId,
            expectedRevision = requestRevision,
          )
      }
      if (applied) resumeVoiceWakeAfterGatewayWords(gatewayScope)
    } catch (_: CancellationException) {
      // A replacement Gateway owns the next refresh.
    } catch (err: Throwable) {
      Log.d("OpenClawRuntime", "voicewake.get failed: ${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun applyVoiceWakeWords(payloadJson: String?) {
    val gatewayScope = captureGatewayDataScope() ?: return
    val words = parseVoiceWakeWords(payloadJson) ?: return
    var applied = false
    publishGatewayData(gatewayScope) {
      applied = applyAuthoritativeVoiceWakeWords(words, gatewayStableId = gatewayScope.stableId)
    }
    if (applied) resumeVoiceWakeAfterGatewayWords(gatewayScope)
  }

  private fun currentVoiceWakeWordsRevision(): Long = synchronized(voiceWakeWordsLock) { voiceWakeWordsRevision }

  private fun applyAuthoritativeVoiceWakeWords(
    words: List<String>,
    gatewayStableId: String,
    expectedRevision: Long? = null,
  ): Boolean =
    synchronized(voiceWakeWordsLock) {
      if (expectedRevision != null && expectedRevision != voiceWakeWordsRevision) return@synchronized false
      voiceWakeWordsRevision += 1
      voiceWakeWordsGatewayStableId = gatewayStableId
      prefs.setVoiceWakeWords(words)
      voiceWakeManager.updateTriggerWords(words)
      true
    }

  private fun invalidateVoiceWakeWordsForGateway() {
    synchronized(voiceWakeWordsLock) {
      voiceWakeWordsRevision += 1
      voiceWakeWordsGatewayStableId = null
      prefs.setVoiceWakeWords(VoiceWakePreferences.defaultTriggerWords)
      voiceWakeManager.updateTriggerWords(VoiceWakePreferences.defaultTriggerWords)
    }
    voiceWakeManager.setSuppressed(VoiceWakeSuppressionReason.GatewaySync, true)
    refreshVoiceWakeCapabilitySurfaceIfChanged()
  }

  private fun resumeVoiceWakeAfterGatewayWords(gatewayScope: GatewayDataScope) {
    if (!isGatewayDataScopeCurrent(gatewayScope) || !isVoiceWakeWordsReadyFor(gatewayScope.stableId)) return
    voiceWakeManager.setSuppressed(VoiceWakeSuppressionReason.GatewaySync, false)
    refreshVoiceWakeCapabilitySurfaceIfChanged()
  }

  private fun isVoiceWakeWordsReadyForCurrentGateway(): Boolean = connectedEndpoint?.stableId?.let(::isVoiceWakeWordsReadyFor) == true

  private fun isVoiceWakeWordsReadyFor(gatewayStableId: String): Boolean = synchronized(voiceWakeWordsLock) { voiceWakeWordsGatewayStableId == gatewayStableId }

  private fun parseVoiceWakeWords(payloadJson: String?): List<String>? =
    runCatching {
      payloadJson
        ?.let(json::parseToJsonElement)
        ?.asObjectOrNull()
        ?.get("triggers")
        ?.let { it as? JsonArray }
        ?.mapNotNull { it.asStringOrNull() }
        ?.let(VoiceWakePreferences::sanitizeTriggerWords)
    }.getOrNull()

  private suspend fun sendVoiceWakeCommand(match: VoiceWakeMatch): Boolean {
    val gatewayId = connectedEndpoint?.stableId ?: return false
    if (!isVoiceWakeWordsReadyFor(gatewayId)) return false
    if (!_nodeConnected.value) return false
    val payload =
      buildJsonObject {
        put("eventId", JsonPrimitive(UUID.randomUUID().toString()))
        put("text", JsonPrimitive(match.command))
        put("sessionKey", JsonPrimitive(resolveMainSessionKey()))
      }
    return nodeSession.sendNodeEventForEndpoint(
      expectedEndpointStableId = gatewayId,
      event = "voice.transcript",
      payloadJson = payload.toString(),
    )
  }

  private fun handleExecApprovalGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    when (event) {
      "exec.approval.requested" -> {
        val approvalId = parseExecApprovalEventId(payloadJson)
        approvalId?.let { id ->
          resolvedExecApprovalIds.remove(id)
          synchronized(execApprovalsStateLock) {
            if (_execApprovalsNotice.value?.approvalId == id) {
              _execApprovalsNotice.value = null
            }
          }
        }
        scope.launch {
          if (approvalId == null) {
            refreshExecApprovalsFromGateway()
          } else {
            refreshExecApprovalFromGateway(approvalId)
          }
        }
      }
      "exec.approval.resolved" -> {
        val approvalId = parseExecApprovalEventId(payloadJson) ?: return
        val methodsSnapshot = captureGatewayMethods()
        when (methodsSnapshot.approvalRpcFamily) {
          GatewayApprovalRpcFamily.Canonical -> {
            // Resolve events can race the local request or come from another surface.
            // Canonical readback preserves the durable winner across that race.
            scope.launch { refreshExecApprovalFromGateway(approvalId) }
          }
          GatewayApprovalRpcFamily.Legacy,
          GatewayApprovalRpcFamily.Unavailable,
          -> {
            val terminal = parseGatewayExecApprovalResolvedEventTerminal(payloadJson ?: return, json)
            synchronized(execApprovalsStateLock) {
              if (terminal != null && _execApprovals.value.any { it.id == approvalId }) {
                _execApprovalsNotice.value = gatewayExecApprovalRemoteTerminalNotice(terminal)
              }
              // Noncanonical peers cannot prove terminal state by readback. The
              // authenticated event is the fail-closed tombstone for this exact ID.
              markExecApprovalResolved(approvalId)
            }
          }
        }
      }
    }
  }

  private fun parseExecApprovalEventId(payloadJson: String?): String? =
    try {
      payloadJson
        ?.let { json.parseToJsonElement(it).asObjectOrNull() }
        ?.get("id")
        ?.let { it as? JsonPrimitive }
        ?.takeIf { it.isString }
        ?.content
        ?.takeIf(::isWellFormedGatewayApprovalId)
    } catch (_: Throwable) {
      null
    }

  private fun parseGatewayUpdateAvailable(payloadJson: String?): GatewayUpdateAvailableSummary? {
    return try {
      val root = payloadJson?.let { json.parseToJsonElement(it).asObjectOrNull() }
      val update = root?.get("updateAvailable").asObjectOrNull() ?: return null
      GatewayUpdateAvailableSummary(
        currentVersion = update["currentVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        latestVersion = update["latestVersion"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
        channel = update["channel"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun parseTalkSessionId(response: String): String {
    val root = json.parseToJsonElement(response).asObjectOrNull()
    val sessionId =
      root?.get("transcriptionSessionId").asStringOrNull()
        ?: root?.get("sessionId").asStringOrNull()
    if (sessionId.isNullOrBlank()) {
      throw IllegalStateException("talk.session.create returned no session id")
    }
    return sessionId
  }

  private fun captureGatewayDataScope(): GatewayDataScope? =
    synchronized(gatewayDataScopeLock) {
      connectedEndpoint?.stableId?.let { GatewayDataScope(it, gatewayDataGeneration) }
    }

  private suspend fun requestGatewayData(
    gatewayScope: GatewayDataScope,
    method: String,
    paramsJson: String?,
    timeoutMs: Long = 15_000,
  ): String {
    gatewayDataRequestTimeoutObserverForTests?.invoke(method, timeoutMs)
    val response =
      gatewayDataRequestOverrideForTests?.invoke(gatewayScope.stableId, method, paramsJson)
        ?: operatorSession.requestForEndpoint(gatewayScope.stableId, method, paramsJson, timeoutMs)
    if (!isGatewayDataScopeCurrent(gatewayScope)) throw CancellationException("gateway scope changed")
    return response
  }

  private suspend fun requestGatewayApprovalData(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    method: String,
    paramsJson: String?,
    preserveWriteFailureAcrossEpoch: Boolean = false,
  ): String {
    if (!isGatewayMethodsSnapshotCurrent(methodsSnapshot)) {
      if (preserveWriteFailureAcrossEpoch) {
        throw GatewayRequestNotEnqueued("gateway connection changed before request")
      }
      throw CancellationException("gateway connection changed")
    }
    return try {
      val response = requestGatewayData(gatewayScope, method, paramsJson)
      if (!isGatewayMethodsSnapshotCurrent(methodsSnapshot)) {
        throw CancellationException("gateway connection changed")
      }
      response
    } catch (err: Throwable) {
      if (!isGatewayMethodsSnapshotCurrent(methodsSnapshot)) {
        // A registered write owner makes definitive and ambiguous failures safe
        // to classify after a same-endpoint reconnect; successes still read back.
        if (
          preserveWriteFailureAcrossEpoch &&
          (err is GatewayRequestDefinitiveFailure || err is GatewayRequestOutcomeUnknown)
        ) {
          throw err
        }
        throw CancellationException("gateway connection changed")
      }
      throw err
    }
  }

  private fun isGatewayDataScopeCurrent(gatewayScope: GatewayDataScope): Boolean =
    synchronized(gatewayDataScopeLock) {
      gatewayScope.generation == gatewayDataGeneration && connectedEndpoint?.stableId == gatewayScope.stableId
    }

  private inline fun publishGatewayData(
    gatewayScope: GatewayDataScope,
    publish: () -> Unit,
  ): Boolean =
    synchronized(gatewayDataScopeLock) {
      if (gatewayScope.generation != gatewayDataGeneration || connectedEndpoint?.stableId != gatewayScope.stableId) {
        false
      } else {
        publish()
        true
      }
    }

  /** Publishes approval state only while the response's operator socket still owns the method catalog. */
  private inline fun publishGatewayApprovalData(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    publish: () -> Unit,
  ): Boolean {
    var approvalPublished = false
    val scopePublished =
      publishGatewayData(gatewayScope) {
        // Lock order stays gateway data -> method catalog -> approval state. The
        // explicit disconnect path already takes the first two in this order.
        synchronized(gatewayMethodsLock) {
          if (methodsSnapshot.epoch == gatewayMethodsEpoch) {
            publish()
            approvalPublished = true
          }
        }
      }
    return scopePublished && approvalPublished
  }

  private inline fun publishCronRefresh(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    crossinline publish: () -> Unit,
  ): Boolean =
    publishGatewayData(gatewayScope) {
      cronRefreshGuard.publishIfCurrent(refreshGeneration) { publish() }
    }

  private inline fun publishProviderModelRefresh(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    crossinline publish: () -> Unit,
  ): Boolean =
    publishGatewayData(gatewayScope) {
      providerModelCatalogRefreshGuard.publishIfCurrent(refreshGeneration) { publish() }
    }

  private suspend fun refreshBrandingFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!gatewayConnectionDisplay.value.isConnected) return
    try {
      val res = requestGatewayData(gatewayScope, "config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      val parsed = parseHexColorArgb(raw)
      publishGatewayData(gatewayScope) {
        _seamColorArgb.value = parsed ?: DEFAULT_SEAM_COLOR_ARGB
        updateHomeCanvasState()
      }
    } catch (_: Throwable) {
      // ignore
    }
  }

  /** Lists one directory of the active agent's workspace (read-only RPC). */
  suspend fun listWorkspaceFiles(
    path: String?,
    offset: Int? = null,
  ): GatewayWorkspaceListing {
    val params =
      buildJsonObject {
        put("agentId", JsonPrimitive(workspaceAgentId()))
        if (!path.isNullOrEmpty()) put("path", JsonPrimitive(path))
        if (offset != null && offset > 0) put("offset", JsonPrimitive(offset))
      }
    val res = operatorSession.request("agents.workspace.list", params.toString())
    return parseWorkspaceListing(json.parseToJsonElement(res))
      ?: throw IllegalStateException("agents.workspace.list returned no listing")
  }

  /** Fetches one workspace file preview (UTF-8 text or base64 image). */
  suspend fun fetchWorkspaceFile(path: String): GatewayWorkspaceFile {
    val params =
      buildJsonObject {
        put("agentId", JsonPrimitive(workspaceAgentId()))
        put("path", JsonPrimitive(path))
      }
    val res = operatorSession.request("agents.workspace.get", params.toString(), timeoutMs = 30_000)
    return parseWorkspaceFile(json.parseToJsonElement(res))
      ?: throw IllegalStateException("agents.workspace.get returned no file")
  }

  private fun workspaceAgentId(): String = resolveActiveAgentId().ifEmpty { "main" }

  private suspend fun refreshAgentsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) return
    try {
      val res = requestGatewayData(gatewayScope, "agents.list", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val defaultAgentId = root["defaultId"].asStringOrNull()?.trim().orEmpty()
      val mainKey = normalizeMainKey(root["mainKey"].asStringOrNull())
      val agents = parseGatewayAgentSummaries(root)

      publishGatewayData(gatewayScope) {
        updateGatewayDefaultAgentId(defaultAgentId)
        _gatewayAgents.value = agents
        val selectedAgentId = selectedChatAgentId?.takeIf { id -> agents.any { it.id == id } }
        selectedChatAgentId = selectedAgentId
        syncMainSessionKey(selectedAgentId ?: resolveAgentIdFromMainSessionKey(mainKey) ?: gatewayDefaultAgentId.value)
        updateHomeCanvasState()
      }
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshModelCatalogFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _modelCatalogRefreshing.value = true
      _modelCatalogErrorText.value = null
    }
    if (!operatorConnected) {
      _modelCatalog.value = emptyList()
      _modelAuthProviders.value = emptyList()
      _modelCatalogRefreshing.value = false
      return
    }
    try {
      val modelsRes = requestGatewayData(gatewayScope, "models.list", "{}")
      val modelsRoot = json.parseToJsonElement(modelsRes).asObjectOrNull()
      val models = parseGatewayModels(modelsRoot?.get("models") as? JsonArray)
      publishGatewayData(gatewayScope) {
        _modelCatalog.value = models
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _modelCatalogErrorText.value = nativeText("Could not load provider catalog.") }
    } finally {
      publishGatewayData(gatewayScope) { _modelCatalogRefreshing.value = false }
    }
  }

  private suspend fun refreshProviderModelsFromGateway() {
    val refreshGeneration = providerModelCatalogRefreshGuard.begin()
    val gatewayScope = captureGatewayDataScope() ?: return
    publishProviderModelRefresh(gatewayScope, refreshGeneration) {
      _providerModelCatalogRefreshing.value = true
      _providerModelCatalogErrorText.value = null
    }
    if (!operatorConnected) {
      publishProviderModelRefresh(gatewayScope, refreshGeneration) {
        _providerModelCatalog.value = emptyList()
        _modelAuthProviders.value = emptyList()
        _providerModelCatalogRefreshing.value = false
      }
      return
    }
    try {
      try {
        val models = requestProviderModelCatalog(gatewayScope)
        publishProviderModelRefresh(gatewayScope, refreshGeneration) {
          _providerModelCatalog.value = models
        }
      } catch (err: Throwable) {
        publishProviderModelRefresh(gatewayScope, refreshGeneration) {
          _providerModelCatalogErrorText.value =
            if (err is ProviderModelConfigUnsupported) {
              nativeText("Update your Gateway to view provider model config.")
            } else {
              nativeText("Could not load provider model config.")
            }
        }
      }

      // Keep readiness independent from the additive provider-config view so
      // older Gateways still populate provider status while prompting an upgrade.
      try {
        val providers = requestModelAuthProviders(gatewayScope)
        publishProviderModelRefresh(gatewayScope, refreshGeneration) {
          _modelAuthProviders.value = providers
        }
      } catch (_: Throwable) {
        publishProviderModelRefresh(gatewayScope, refreshGeneration) {
          if (_providerModelCatalogErrorText.value == null) {
            _providerModelCatalogErrorText.value =
              nativeText("Provider models loaded, but readiness is unavailable.")
          }
        }
      }
    } finally {
      publishProviderModelRefresh(gatewayScope, refreshGeneration) {
        _providerModelCatalogRefreshing.value = false
      }
    }
  }

  private suspend fun requestProviderModelCatalog(gatewayScope: GatewayDataScope): List<GatewayModelSummary> {
    val modelsRes =
      requestProviderModelConfig { paramsJson ->
        requestGatewayData(gatewayScope, "models.list", paramsJson)
      }
    val modelsRoot = json.parseToJsonElement(modelsRes).asObjectOrNull()
    return parseGatewayModels(modelsRoot?.get("models") as? JsonArray)
  }

  private suspend fun requestModelAuthProviders(gatewayScope: GatewayDataScope): List<GatewayModelProviderSummary> {
    val authRes = requestGatewayData(gatewayScope, "models.authStatus", "{}")
    val authRoot = json.parseToJsonElement(authRes).asObjectOrNull()
    return parseGatewayModelProviders(authRoot?.get("providers") as? JsonArray)
  }

  private suspend fun refreshTalkSetupReadinessFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) {
      _talkSetupReadiness.value = GatewayTalkSetupReadiness.unverified()
      return
    }
    val readiness =
      try {
        val response = requestGatewayData(gatewayScope, "talk.catalog", "{}")
        parseGatewayTalkSetupReadiness(json.parseToJsonElement(response).asObjectOrNull())
      } catch (_: Throwable) {
        GatewayTalkSetupReadiness.unverified(GatewayTalkSetupIssue.CatalogLoadFailed)
      }
    publishGatewayData(gatewayScope) { _talkSetupReadiness.value = readiness }
  }

  private suspend fun refreshCronFromGateway() {
    val refreshGeneration = cronRefreshGuard.begin()
    val gatewayScope = captureGatewayDataScope() ?: return
    publishCronRefresh(gatewayScope, refreshGeneration) {
      _cronRefreshing.value = true
      _cronErrorText.value = null
    }
    if (!operatorConnected) {
      publishCronRefresh(gatewayScope, refreshGeneration) {
        _cronStatus.value = GatewayCronStatus(enabled = false, jobs = 0, nextWakeAtMs = null)
        _cronJobs.value = emptyList()
        _cronRefreshing.value = false
      }
      return
    }
    try {
      val statusRes = requestGatewayData(gatewayScope, "cron.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      val status =
        GatewayCronStatus(
          enabled = statusRoot.boolean("enabled"),
          jobs = statusRoot.long("jobs")?.toInt() ?: 0,
          nextWakeAtMs = statusRoot.long("nextWakeAtMs"),
        )

      var snapshot: List<GatewayCronJobSummary>? = null
      repeat(CRON_JOBS_SNAPSHOT_MAX_ATTEMPTS) {
        if (snapshot == null) snapshot = requestCronJobsSnapshot(gatewayScope)
      }
      val jobs =
        requireNotNull(snapshot) {
          "Gateway cron jobs changed repeatedly while loading."
        }
      val sortedJobs =
        jobs.sortedWith(
          compareBy<GatewayCronJobSummary> { it.nextRunAtMs == null }
            .thenBy { it.nextRunAtMs ?: Long.MAX_VALUE }
            .thenBy { it.id },
        )
      publishCronRefresh(gatewayScope, refreshGeneration) {
        _cronStatus.value = status
        _cronJobs.value = sortedJobs
      }
    } catch (_: Throwable) {
      publishCronRefresh(gatewayScope, refreshGeneration) {
        _cronErrorText.value = nativeText("Could not load automations.")
      }
    } finally {
      publishCronRefresh(gatewayScope, refreshGeneration) {
        _cronRefreshing.value = false
      }
    }
  }

  private suspend fun requestCronJobsSnapshot(
    gatewayScope: GatewayDataScope,
  ): List<GatewayCronJobSummary>? {
    val jobs = mutableListOf<GatewayCronJobSummary>()
    val jobIds = mutableSetOf<String>()
    var offset = 0
    var complete = false
    var pageCount = 0
    var expectedTotal: Long? = null
    var expectedSnapshotRevision: String? = null
    var snapshotRevisionSupported: Boolean? = null
    while (pageCount < CRON_JOBS_MAX_PAGES && !complete) {
      pageCount += 1
      val listParams =
        buildJsonObject {
          put("includeDisabled", JsonPrimitive(true))
          put("limit", JsonPrimitive(CRON_JOBS_PAGE_SIZE))
          put("offset", JsonPrimitive(offset))
          // nextRunAtMs changes as jobs execute; name plus the server's id tie-breaker
          // keeps offsets stable while paging, then we restore scheduler order below.
          put("sortBy", JsonPrimitive("name"))
          put("sortDir", JsonPrimitive("asc"))
        }.toString()
      val listRes = requestGatewayData(gatewayScope, "cron.list", listParams)
      val listRoot = json.parseToJsonElement(listRes).asObjectOrNull()
      val rawJobs = listRoot?.get("jobs") as? JsonArray
      val pageJobs = parseCronJobs(rawJobs)
      val total =
        requireNotNull(listRoot.long("total")) {
          "Gateway did not return a cron jobs total."
        }
      require(total in 0L..CRON_JOBS_MAX_COUNT.toLong()) {
        "Gateway returned an invalid cron jobs total."
      }
      if (expectedTotal != null && total != expectedTotal) return null
      expectedTotal = total
      val snapshotRevision =
        (listRoot?.get("snapshotRevision") as? JsonPrimitive)
          ?.contentOrNull
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
      val pageSupportsSnapshotRevision = snapshotRevision != null
      if (
        snapshotRevisionSupported != null &&
        snapshotRevisionSupported != pageSupportsSnapshotRevision
      ) {
        return null
      }
      snapshotRevisionSupported = pageSupportsSnapshotRevision
      if (expectedSnapshotRevision != null && snapshotRevision != expectedSnapshotRevision) return null
      expectedSnapshotRevision = snapshotRevision
      for (job in pageJobs) {
        // Offset pages are separately locked by the Gateway. A mutation between
        // calls can shift a boundary; discard the partial snapshot and retry.
        if (!jobIds.add(job.id)) return null
      }
      jobs += pageJobs
      require(jobs.size <= CRON_JOBS_MAX_COUNT) { "Gateway returned too many cron jobs." }
      require(total >= jobs.size.toLong()) {
        "Gateway returned an invalid cron jobs total."
      }
      val nextOffset = nextCronJobsPageOffset(listRoot, offset, rawJobs?.size ?: 0)
      if (nextOffset == null) {
        complete = true
        break
      }
      require(nextOffset <= CRON_JOBS_MAX_COUNT) { "Gateway returned too many cron jobs." }
      offset = nextOffset
    }
    require(complete) { "Gateway returned too many cron job pages." }
    return jobs.takeIf { it.size.toLong() == expectedTotal }
  }

  private suspend fun loadCronJobDetailFromGateway(request: CronJobDetailRequest) {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) {
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value = GatewayCronJobDetailState.Error(request.id, nativeText("Connect the gateway to inspect automations."))
      }
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "cron.get", cronJobGetParams(request.id))
      val root = json.parseToJsonElement(res).asObjectOrNull()
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value =
          parseGatewayCronJobDetail(root)?.let(GatewayCronJobDetailState::Loaded)
            ?: GatewayCronJobDetailState.Error(request.id, nativeText("Gateway returned an invalid automation."))
      }
    } catch (_: Throwable) {
      cronJobDetailRequestGuard.publishIfCurrent(request) {
        _cronJobDetailState.value = GatewayCronJobDetailState.Error(request.id, nativeText("Could not load automation."))
      }
    }
  }

  private suspend fun loadCronRunHistoryFromGateway(request: CronJobDetailRequest) {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) {
      cronRunHistoryRequestGuard.publishIfCurrent(request) {
        _cronRunHistoryState.value =
          GatewayCronRunHistoryState.Error(
            id = request.id,
            message = nativeString("Connect the gateway to inspect automation run history."),
          )
      }
      return
    }
    try {
      val response =
        requestGatewayData(
          gatewayScope,
          "cron.runs",
          buildJsonObject {
            put("id", JsonPrimitive(request.id))
            put("limit", JsonPrimitive(20))
            put("sortDir", JsonPrimitive("desc"))
          }.toString(),
        )
      val root = json.parseToJsonElement(response).asObjectOrNull()
      val runs = parseGatewayCronRunHistory(root?.get("entries") as? JsonArray)
      publishGatewayData(gatewayScope) {
        cronRunHistoryRequestGuard.publishIfCurrent(request) {
          _cronRunHistoryState.value = GatewayCronRunHistoryState.Loaded(id = request.id, runs = runs)
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        cronRunHistoryRequestGuard.publishIfCurrent(request) {
          _cronRunHistoryState.value =
            GatewayCronRunHistoryState.Error(
              id = request.id,
              message = nativeString("Could not load automation run history."),
            )
        }
      }
    }
  }

  private fun launchCronAction(
    id: String,
    action: GatewayCronAction,
    perform: suspend (GatewayDataScope, String) -> CronActionResult,
  ) {
    val jobId = id.trim().takeIf { it.isNotEmpty() } ?: return
    if (!operatorAdminScopeAvailable.value) {
      _cronActionState.value =
        GatewayCronActionState.Notice(
          id = jobId,
          message = nativeText("Cron changes require operator.admin access."),
          kind = GatewayCronNoticeKind.Error,
        )
      return
    }
    if (!operatorConnected) {
      _cronActionState.value =
        GatewayCronActionState.Notice(
          id = jobId,
          message = nativeText("Connect the gateway to manage automations."),
          kind = GatewayCronNoticeKind.Error,
        )
      return
    }
    if (_cronActionState.value is GatewayCronActionState.Running) return
    // One mutating RPC at a time keeps button taps and programmatic calls from racing.
    if (!cronActionMutex.tryLock()) {
      if (_cronActionState.value !is GatewayCronActionState.Running) {
        _cronActionState.value =
          GatewayCronActionState.Notice(
            id = jobId,
            message = nativeText("Another cron action is still finishing."),
            kind = GatewayCronNoticeKind.Warning,
          )
      }
      return
    }
    // Publish ownership before returning to Compose so Activity recreation can
    // distinguish a retained Save from dead pending state after process death.
    val actionScope = captureGatewayDataScope()
    if (actionScope == null) {
      cronActionMutex.unlock()
      return
    }
    val started =
      publishGatewayData(actionScope) {
        _cronActionState.value = GatewayCronActionState.Running(id = jobId, action = action)
      }
    if (!started) {
      cronActionMutex.unlock()
      return
    }
    scope.launch {
      var completionState: GatewayCronActionState.Notice? = null
      try {
        val result = perform(actionScope, jobId)
        if (result.deleted) {
          clearDeletedCronSelection(jobId)
        }
        if (result.refresh) {
          refreshCronFromGateway()
          if (!result.deleted) reloadCronJobIfSelected(jobId)
        }
        completionState =
          GatewayCronActionState.Notice(
            id = jobId,
            message = result.message,
            kind = result.kind,
            deleted = result.deleted,
          )
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        val message =
          err.message
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let(::verbatimText)
            ?: nativeText("Cron action failed.")
        completionState =
          GatewayCronActionState.Notice(
            id = jobId,
            message = message,
            kind = GatewayCronNoticeKind.Error,
          )
      } finally {
        cronActionMutex.unlock()
        val notice = completionState
        if (notice != null) {
          publishGatewayData(actionScope) {
            _cronActionState.value = notice
          }
        }
      }
    }
  }

  private fun reloadCronJobIfSelected(jobId: String) {
    // Ownership checks and loading publication stay under each guard's lock;
    // navigation that wins afterward invalidates these requests before publish.
    val detailRequest =
      cronJobDetailRequestGuard.beginIfCurrent(jobId) { request ->
        _cronJobDetailState.value = GatewayCronJobDetailState.Loading(request.id)
      }
    val historyRequest =
      cronRunHistoryRequestGuard.beginIfCurrent(jobId) { request ->
        _cronRunHistoryState.value = GatewayCronRunHistoryState.Loading(request.id)
      }
    detailRequest?.let { scope.launch { loadCronJobDetailFromGateway(it) } }
    historyRequest?.let { scope.launch { loadCronRunHistoryFromGateway(it) } }
  }

  private fun clearDeletedCronSelection(jobId: String) {
    // A completed delete can race navigation to another job. Clear only state
    // still owned by the deleted id so the newer detail/history survives.
    cronJobDetailRequestGuard.cancelIfCurrent(jobId) {
      _cronJobDetailState.value = GatewayCronJobDetailState.Idle
    }
    cronRunHistoryRequestGuard.cancelIfCurrent(jobId) {
      _cronRunHistoryState.value = GatewayCronRunHistoryState.Idle
    }
  }

  private fun trackQueuedCronRun(
    gatewayScope: GatewayDataScope,
    jobId: String,
    runId: String,
  ) {
    // cron.run acknowledges before lane admission. Track its exact run-log id
    // so only this job stays deduped until terminal evidence or scope retirement.
    scope.launch {
      var completedRun: GatewayCronRunSummary? = null
      while (isGatewayDataScopeCurrent(gatewayScope) && completedRun == null) {
        completedRun =
          try {
            val response =
              requestGatewayData(
                gatewayScope,
                "cron.runs",
                buildJsonObject {
                  put("id", JsonPrimitive(jobId))
                  put("runId", JsonPrimitive(runId))
                  put("limit", JsonPrimitive(1))
                  put("sortDir", JsonPrimitive("desc"))
                }.toString(),
              )
            val root = json.parseToJsonElement(response).asObjectOrNull()
            parseGatewayCronRunHistory(root?.get("entries") as? JsonArray)
              .firstOrNull { it.runId == runId }
          } catch (err: CancellationException) {
            throw err
          } catch (_: Throwable) {
            if (!isGatewayDataScopeCurrent(gatewayScope)) return@launch
            null
          }
        if (completedRun == null) delay(CRON_RUN_TRACKING_POLL_MS)
      }
      if (!isGatewayDataScopeCurrent(gatewayScope)) return@launch
      val terminalRun = completedRun ?: return@launch

      var pendingCleared = false
      val scopeCurrent =
        publishGatewayData(gatewayScope) {
          pendingCleared =
            pendingCronRunRegistry.finish(jobId, runId) {
              _pendingCronRunJobIds.value = it
            }
        }
      if (!scopeCurrent || !pendingCleared) return@launch

      refreshCronFromGateway()
      reloadCronJobIfSelected(jobId)
      publishGatewayData(gatewayScope) {
        val currentAction = _cronActionState.value
        val canPublish =
          currentAction == GatewayCronActionState.Idle ||
            (currentAction is GatewayCronActionState.Notice && currentAction.id == jobId)
        if (canPublish) {
          _cronActionState.value = cronRunCompletionNotice(jobId, terminalRun.status)
        }
      }
    }
  }

  private suspend fun refreshUsageFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _usageRefreshing.value = true
      _usageErrorText.value = null
    }
    if (!operatorConnected) {
      _usageSummary.value = GatewayUsageSummary(updatedAtMs = null, providers = emptyList())
      _usageRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "usage.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewayUsageSummary(
          updatedAtMs = root.long("updatedAt"),
          providers = parseUsageProviders(root?.get("providers") as? JsonArray),
        )
      publishGatewayData(gatewayScope) { _usageSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _usageErrorText.value = nativeText("Could not load usage.") }
    } finally {
      publishGatewayData(gatewayScope) { _usageRefreshing.value = false }
    }
  }

  private suspend fun refreshSkillsFromGateway(): Boolean {
    val gatewayScope = captureGatewayDataScope() ?: return false
    publishGatewayData(gatewayScope) {
      _skillsRefreshing.value = true
      _skillsErrorText.value = null
    }
    if (!operatorConnected) {
      _skillsSummary.value = GatewaySkillsSummary(skills = emptyList())
      _skillsRefreshing.value = false
      return false
    }
    try {
      val res = requestGatewayData(gatewayScope, "skills.status", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewaySkillsSummary(
          managedSkillsDirAvailable =
            root
              ?.get("managedSkillsDir")
              .asStringOrNull()
              ?.trim()
              ?.isNotEmpty() == true,
          skills = parseSkillSummaries(root?.get("skills") as? JsonArray),
        )
      publishGatewayData(gatewayScope) {
        _skillsSummary.value = summary
      }
      return true
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _skillsErrorText.value = nativeText("Could not load skills.") }
      return false
    } finally {
      publishGatewayData(gatewayScope) { _skillsRefreshing.value = false }
    }
  }

  private suspend fun setSkillEnabledOnGateway(
    skillKey: String,
    enabled: Boolean,
  ) {
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillsErrorText.value = nativeText("Connect the gateway to update skills.")
      return
    }
    if (!operatorAdminScopeAvailable.value) {
      _skillsErrorText.value = nativeText("This gateway connection needs operator.admin to update skills.")
      return
    }
    publishGatewayData(gatewayScope) {
      _skillMutationKeys.value = _skillMutationKeys.value + skillKey
      _skillsErrorText.value = null
    }
    try {
      requestGatewayData(gatewayScope, "skills.update", skillEnabledParams(skillKey, enabled))
      refreshSkillsFromGateway()
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        _skillsErrorText.value =
          nativeText(if (enabled) "Could not enable skill." else "Could not disable skill.")
      }
    } finally {
      publishGatewayData(gatewayScope) {
        _skillMutationKeys.value = _skillMutationKeys.value - skillKey
      }
    }
  }

  private suspend fun searchClawHubSkillsFromGateway(query: String) {
    val normalized = query.trim()
    val searchSeq = clawHubSkillSearchSeq.incrementAndGet()
    clawHubSkillReviewSeq.incrementAndGet()
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _clawHubSkillSearchState.value =
        GatewayClawHubSkillSearchState(
          query = normalized,
          errorText = nativeString("Connect the gateway to search ClawHub skills."),
        )
      return
    }
    if (!clawHubSkillMethodsAvailable.value) {
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(errorText = CLAWHUB_SKILL_GATEWAY_UNAVAILABLE)
      }
      return
    }
    publishGatewayData(gatewayScope) {
      _clawHubSkillSearchState.value =
        _clawHubSkillSearchState.value.copy(
          query = normalized,
          searching = true,
          results = emptyList(),
          reviewingSlug = null,
          installReview = null,
          acknowledgeSlug = null,
          acknowledgeVersion = null,
          errorText = null,
          messageText = null,
        )
    }
    try {
      val response = requestGatewayData(gatewayScope, "skills.search", clawHubSearchParams(normalized))
      val results = parseClawHubSearchResults(response, json)
      publishGatewayData(gatewayScope) {
        if (clawHubSkillSearchSeq.get() == searchSeq) {
          _clawHubSkillSearchState.value =
            _clawHubSkillSearchState.value.copy(
              searching = false,
              results = results,
              messageText = if (results.isEmpty()) "No ClawHub skills matched." else null,
            )
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (clawHubSkillSearchSeq.get() == searchSeq) {
          _clawHubSkillSearchState.value =
            _clawHubSkillSearchState.value.copy(
              searching = false,
              errorText = nativeString("Could not search ClawHub skills."),
            )
        }
      }
    }
  }

  private suspend fun reviewClawHubSkillInstallFromGateway(skill: GatewayClawHubSkillSummary) {
    val reviewSeq = clawHubSkillReviewSeq.incrementAndGet()
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _clawHubSkillSearchState.value =
        _clawHubSkillSearchState.value.copy(
          errorText = nativeString("Connect the gateway to inspect ClawHub skills."),
        )
      return
    }
    if (!clawHubSkillMethodsAvailable.value) {
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(errorText = CLAWHUB_SKILL_GATEWAY_UNAVAILABLE)
      }
      return
    }
    publishGatewayData(gatewayScope) {
      _clawHubSkillSearchState.value =
        _clawHubSkillSearchState.value.copy(
          reviewingSlug = skill.slug,
          installReview = null,
          acknowledgeSlug = null,
          acknowledgeVersion = null,
          errorText = null,
          messageText = null,
        )
    }
    try {
      val response = requestGatewayData(gatewayScope, "skills.detail", clawHubDetailParams(skill.slug))
      val review = parseClawHubInstallReview(response, skill, json)
      publishGatewayData(gatewayScope) {
        if (clawHubSkillReviewSeq.get() == reviewSeq) {
          _clawHubSkillSearchState.value =
            _clawHubSkillSearchState.value.copy(
              reviewingSlug = null,
              installReview = review,
              errorText =
                if (review == null) {
                  "ClawHub did not return an installable version for ${skill.slug}."
                } else {
                  null
                },
            )
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (clawHubSkillReviewSeq.get() == reviewSeq) {
          _clawHubSkillSearchState.value =
            _clawHubSkillSearchState.value.copy(
              reviewingSlug = null,
              errorText =
                nativeString("Could not load ClawHub details for \${skill.slug}.", skill.slug),
            )
        }
      }
    }
  }

  private suspend fun installClawHubSkillFromGateway(
    slug: String,
    acknowledgeClawHubRisk: Boolean,
    version: String?,
  ) {
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _clawHubSkillSearchState.value =
        _clawHubSkillSearchState.value.copy(
          errorText = nativeString("Connect the gateway to install ClawHub skills."),
        )
      return
    }
    if (!clawHubSkillMethodsAvailable.value) {
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(errorText = CLAWHUB_SKILL_GATEWAY_UNAVAILABLE)
      }
      return
    }
    if (!operatorAdminScopeAvailable.value) {
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            errorText =
              nativeString(
                "This gateway connection needs operator.admin to install ClawHub skills.",
              ),
          )
      }
      return
    }
    clawHubSkillInstallBeforeClaimObserverForTests?.invoke()
    val claimed =
      clawHubSkillInstallMutex.withLock {
        var published = false
        // Gateway switches reset this shared UI state while installs can wait
        // on the mutex. Claim under the scope lock so stale work cannot leak in.
        publishGatewayData(gatewayScope) {
          val current = _clawHubSkillSearchState.value
          if (slug !in current.installingSlugs) {
            _clawHubSkillSearchState.value =
              current.copy(installingSlugs = current.installingSlugs + slug)
            published = true
          }
        }
        published
      }
    if (!claimed) return
    val attemptedVersion = version?.trim()?.takeIf(String::isNotEmpty)
    publishGatewayData(gatewayScope) {
      _clawHubSkillSearchState.value =
        _clawHubSkillSearchState.value.copy(
          installReview = null,
          acknowledgeSlug = null,
          acknowledgeVersion = null,
          errorText = null,
          messageText = null,
        )
    }
    try {
      val response =
        requestGatewayData(
          gatewayScope,
          "skills.install",
          clawHubInstallParams(slug, attemptedVersion, acknowledgeClawHubRisk),
          timeoutMs = CLAWHUB_INSTALL_REQUEST_TIMEOUT_MS,
        )
      val root = json.parseToJsonElement(response).asObjectOrNull()
      val message =
        root
          ?.get("message")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      val warning =
        root
          ?.get("warning")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      val refreshed = refreshSkillsFromGateway()
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            messageText =
              formatClawHubInstallMessage(
                message ?: "Installed $slug.",
                listOfNotNull(
                  warning,
                  if (refreshed) null else "Installed, but the skills list could not be refreshed.",
                ).joinToString("\n").ifBlank { null },
              ),
          )
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: GatewayRequestOutcomeUnknown) {
      val confirmed = refreshAndConfirmClawHubInstall(gatewayScope, slug, attemptedVersion)
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            errorText = if (confirmed) null else clawHubInstallOutcomeUnknownMessage(slug),
            messageText = if (confirmed) "Installed $slug." else null,
          )
      }
    } catch (err: GatewayRequestRejected) {
      val confirmed = refreshAndConfirmClawHubInstall(gatewayScope, slug, attemptedVersion)
      val rejection = if (confirmed) null else clawHubInstallRejection(err.gatewayError, attemptedVersion)
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            acknowledgeSlug = if (rejection?.requiresAcknowledgement == true) slug else null,
            acknowledgeVersion = rejection?.acknowledgeVersion,
            errorText = rejection?.let { formatClawHubInstallMessage(it.message, it.warning) },
            messageText = if (confirmed) "Installed $slug." else null,
          )
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            errorText = nativeString("Could not install \${slug} from ClawHub.", slug),
          )
      }
    } finally {
      releaseClawHubInstallClaim(slug, gatewayScope)
    }
  }

  private suspend fun refreshAndConfirmClawHubInstall(
    gatewayScope: GatewayDataScope,
    slug: String,
    version: String?,
  ): Boolean {
    val exactVersion = version ?: return false
    if (!refreshSkillsFromGateway() || !isGatewayDataScopeCurrent(gatewayScope)) return false
    return isClawHubSkillInstalled(_skillsSummary.value.skills, slug, exactVersion)
  }

  private suspend fun releaseClawHubInstallClaim(
    slug: String,
    gatewayScope: GatewayDataScope? = null,
  ) {
    clawHubSkillInstallMutex.withLock {
      val release = {
        _clawHubSkillSearchState.value =
          _clawHubSkillSearchState.value.copy(
            installingSlugs = _clawHubSkillSearchState.value.installingSlugs - slug,
          )
      }
      if (gatewayScope == null) release() else publishGatewayData(gatewayScope, release)
    }
  }

  private suspend fun refreshSkillWorkshopProposalsFromGateway(agentId: String?) {
    val listSeq = skillWorkshopListSeq.incrementAndGet()
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = emptyList())
      _skillWorkshopRefreshing.value = false
      _skillWorkshopErrorText.value = nativeText("Connect the gateway to load Skill Workshop proposals.")
      return
    }
    publishGatewayData(gatewayScope) {
      _skillWorkshopRefreshing.value = true
      _skillWorkshopErrorText.value = null
      if (_skillWorkshopSummary.value.agentId != requestAgentId) {
        _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = emptyList())
        _skillWorkshopNoticeText.value = null
        _skillWorkshopInspectingProposalId.value = null
        _skillWorkshopMutatingProposalId.value = null
        skillWorkshopInspectSeq.incrementAndGet()
        skillWorkshopMutationSeq.incrementAndGet()
      }
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.list",
          skillWorkshopParams(agentId = agentId).toString(),
        )
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val previousById =
        _skillWorkshopSummary.value
          .takeIf { it.agentId == requestAgentId }
          ?.proposals
          ?.associateBy { it.id }
          .orEmpty()
      val proposals = parseSkillWorkshopProposals(root?.get("proposals") as? JsonArray, previousById)
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopSummary.value = GatewaySkillWorkshopSummary(agentId = requestAgentId, proposals = proposals)
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = nativeText("Could not load Skill Workshop proposals.")
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopListSeq.get() == listSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopRefreshing.value = false
        }
      }
    }
  }

  private suspend fun inspectSkillWorkshopProposalFromGateway(
    proposalId: String,
    agentId: String?,
  ) {
    var inspectSeq = 0L
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopErrorText.value = nativeText("Connect the gateway to inspect Skill Workshop proposals.")
      return
    }
    var inspectStarted = false
    val scopeCurrent =
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId } &&
          _skillWorkshopMutatingProposalId.value == null
        ) {
          inspectStarted = true
          inspectSeq = skillWorkshopInspectSeq.incrementAndGet()
          _skillWorkshopInspectingProposalId.value = proposalId
          _skillWorkshopErrorText.value = null
        }
      }
    if (!scopeCurrent || !inspectStarted) {
      return
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.inspect",
          skillWorkshopParams(agentId = agentId, proposalId = proposalId).toString(),
        )
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val previous =
        _skillWorkshopSummary.value
          .takeIf { it.agentId == requestAgentId }
          ?.proposals
          ?.firstOrNull { it.id == proposalId }
      val inspected =
        parseSkillWorkshopProposalInspect(root, previous)
          ?: throw IllegalStateException("skills.proposals.inspect returned no proposal")
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          skillWorkshopInspectSeq.get() == inspectSeq &&
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId }
        ) {
          _skillWorkshopSummary.value = _skillWorkshopSummary.value.withProposal(inspected)
        }
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopInspectSeq.get() == inspectSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = nativeText("Could not inspect Skill Workshop proposal.")
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopInspectSeq.get() == inspectSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopInspectingProposalId.value = null
        }
      }
    }
  }

  private suspend fun mutateSkillWorkshopProposalOnGateway(
    proposalId: String,
    agentId: String?,
    action: SkillWorkshopGatewayAction,
  ) {
    var mutationSeq = 0L
    val requestAgentId = normalizeSkillWorkshopAgentId(agentId)
    if (!operatorAdminScopeAvailable.value) {
      _skillWorkshopErrorText.value = nativeText("Skill Workshop proposal actions require operator.admin scope.")
      return
    }
    val gatewayScope = captureGatewayDataScope()
    if (gatewayScope == null || !operatorConnected) {
      _skillWorkshopErrorText.value = nativeText("Connect the gateway to update Skill Workshop proposals.")
      return
    }
    var mutationStarted = false
    val scopeCurrent =
      publishGatewayData(gatewayScope) {
        val currentSummary = _skillWorkshopSummary.value
        if (
          currentSummary.agentId == requestAgentId &&
          currentSummary.proposals.any { it.id == proposalId } &&
          _skillWorkshopMutatingProposalId.value == null
        ) {
          mutationStarted = true
          mutationSeq = skillWorkshopMutationSeq.incrementAndGet()
          // A lifecycle action supersedes any older detail read. Without this
          // guard, a late inspect response can restore the pre-action status.
          skillWorkshopInspectSeq.incrementAndGet()
          _skillWorkshopInspectingProposalId.value = null
          _skillWorkshopMutatingProposalId.value = proposalId
          _skillWorkshopErrorText.value = null
          _skillWorkshopNoticeText.value = null
        }
      }
    if (!scopeCurrent || !mutationStarted) {
      return
    }
    try {
      val res =
        requestGatewayData(
          gatewayScope,
          "skills.proposals.${action.methodSuffix}",
          skillWorkshopParams(agentId = agentId, proposalId = proposalId).toString(),
        )
      val updatedProposal =
        parseSkillWorkshopProposalActionResult(
          root = json.parseToJsonElement(res).asObjectOrNull(),
          previous =
            _skillWorkshopSummary.value
              .takeIf { it.agentId == requestAgentId }
              ?.proposals
              ?.firstOrNull { it.id == proposalId },
        )
      var mutationConfirmed = false
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          if (updatedProposal?.status == action.expectedStatus) {
            _skillWorkshopSummary.value = _skillWorkshopSummary.value.withProposal(updatedProposal)
            _skillWorkshopNoticeText.value = action.notice
            mutationConfirmed = true
          } else {
            _skillWorkshopErrorText.value = skillWorkshopUnexpectedStatusText(updatedProposal?.status, action)
          }
        }
      }
      if (!mutationConfirmed) return
      var refreshStillCurrent = false
      publishGatewayData(gatewayScope) {
        refreshStillCurrent =
          skillWorkshopMutationSeq.get() == mutationSeq &&
          _skillWorkshopSummary.value.agentId == requestAgentId
      }
      if (refreshStillCurrent) {
        refreshSkillWorkshopProposalsFromGateway(agentId = agentId)
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopErrorText.value = skillWorkshopActionFailureText(action)
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (skillWorkshopMutationSeq.get() == mutationSeq && _skillWorkshopSummary.value.agentId == requestAgentId) {
          _skillWorkshopMutatingProposalId.value = null
        }
      }
    }
  }

  private fun normalizeSkillWorkshopAgentId(agentId: String?): String = agentId?.trim().orEmpty()

  private fun skillWorkshopParams(
    agentId: String?,
    proposalId: String? = null,
  ): JsonObject =
    buildJsonObject {
      val normalizedAgentId = agentId?.trim()?.takeIf { it.isNotEmpty() }
      if (normalizedAgentId != null) put("agentId", JsonPrimitive(normalizedAgentId))
      val normalizedProposalId = proposalId?.trim()?.takeIf { it.isNotEmpty() }
      if (normalizedProposalId != null) put("proposalId", JsonPrimitive(normalizedProposalId))
    }

  private suspend fun mutateDevicePairingOnGateway(
    gatewayScope: GatewayDataScope,
    mutation: GatewayDevicePairingMutation,
    expectedDeviceId: String,
  ) {
    publishGatewayData(gatewayScope) {
      _nodesDevicesErrorText.value = null
      _nodesDevicesNoticeText.value = null
    }
    try {
      // A missing item alone is ambiguous: another operator may have resolved it.
      // Require the exact write acknowledgement plus the canonical list terminal state.
      var definitiveFailure: NativeText? = null
      val mutationAccepted =
        try {
          val response =
            requestGatewayData(
              gatewayScope = gatewayScope,
              method = mutation.action.method,
              paramsJson = buildGatewayDevicePairingMutationParams(mutation).toString(),
            )
          val result = json.parseToJsonElement(response).asObjectOrNull()
          when (mutation.action) {
            GatewayDevicePairingAction.Approve ->
              result?.get("requestId").asStringOrNull()?.trim() == mutation.targetId &&
                result
                  ?.get("device")
                  .asObjectOrNull()
                  ?.get("deviceId")
                  .asStringOrNull()
                  ?.trim() ==
                expectedDeviceId
            GatewayDevicePairingAction.Reject ->
              result?.get("requestId").asStringOrNull()?.trim() == mutation.targetId
            GatewayDevicePairingAction.Remove ->
              result?.get("deviceId").asStringOrNull()?.trim() == mutation.targetId
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: GatewayRequestRejected) {
          definitiveFailure = verbatimText(err.gatewayError.message)
          false
        } catch (err: GatewayRequestDefinitiveFailure) {
          definitiveFailure = verbatimText(err.message ?: "Gateway request failed.")
          false
        } catch (_: GatewayRequestOutcomeUnknown) {
          false
        } catch (_: Throwable) {
          false
        }

      val devicesRoot =
        try {
          val response = requestGatewayData(gatewayScope, "device.pair.list", "{}")
          json.parseToJsonElement(response).asObjectOrNull()
        } catch (err: CancellationException) {
          throw err
        } catch (_: Throwable) {
          null
        }
      val pending = parsePendingDevices(devicesRoot?.get("pending") as? JsonArray)
      val paired = parsePairedDevices(devicesRoot?.get("paired") as? JsonArray)
      val hasCanonicalList =
        devicesRoot?.get("pending") is JsonArray && devicesRoot["paired"] is JsonArray
      val outcome =
        if (hasCanonicalList) {
          verifyGatewayDevicePairingMutation(
            mutation = mutation,
            expectedDeviceId = expectedDeviceId,
            mutationAccepted = mutationAccepted,
            pending = pending,
            paired = paired,
          )
        } else {
          GatewayDevicePairingMutationOutcome.NotVerified
        }
      publishGatewayData(gatewayScope) {
        if (hasCanonicalList) {
          // Claim the generation only with the canonical post-mutation list in hand and only
          // while this gateway scope is still current: older refreshes that read pre-mutation
          // state are invalidated, a stale mutation from a previous gateway cannot touch the
          // new gateway's refresh, and the mutation takes over the refreshing flag it displaced.
          val refreshGeneration = nodeApprovalRefreshGuard.begin()
          nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
            _nodesDevicesSummary.value =
              _nodesDevicesSummary.value.copy(
                pendingDevices = pending,
                pairedDevices = paired,
                devicePairingAvailable = true,
              )
            _nodesDevicesRefreshing.value = false
          }
        }
        if (definitiveFailure != null) {
          _nodesDevicesErrorText.value = definitiveFailure
        } else if (outcome == GatewayDevicePairingMutationOutcome.NotVerified) {
          _nodesDevicesErrorText.value = nativeText("Could not verify the device pairing change. Refresh and try again.")
        } else {
          _nodesDevicesNoticeText.value = mutation.action.successNotice
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        synchronized(devicePairingMutationLock) {
          if (_devicePairingMutation.value == mutation) {
            _devicePairingMutation.value = null
          }
        }
      }
    }
  }

  private suspend fun refreshNodesDevicesFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    val refreshGeneration = nodeApprovalRefreshGuard.begin()
    var refreshStarted = false
    val currentScope =
      publishGatewayData(gatewayScope) {
        refreshStarted =
          nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
            _nodesDevicesRefreshing.value = true
            _nodesDevicesErrorText.value = null
            _nodesDevicesNoticeText.value = null
            _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
            val pendingFallback = _nodeCapabilityApproval.value.withoutExactRequestId()
            if (pendingFallback != null) {
              _nodeCapabilityApproval.value = pendingFallback
            } else if (
              _nodeCapabilityApproval.value !is GatewayNodeCapabilityApproval.PendingApproval &&
              _nodeCapabilityApproval.value !is GatewayNodeCapabilityApproval.PendingReapproval
            ) {
              _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
            }
          }
      }
    if (!currentScope || !refreshStarted) return
    if (!operatorConnected) {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
          _nodesDevicesSummary.value =
            GatewayNodesDevicesSummary(
              nodes = emptyList(),
              pendingDevices = emptyList(),
              pairedDevices = emptyList(),
            )
          _nodesDevicesRefreshing.value = false
        }
      }
      return
    }
    try {
      val nodesRes = requestGatewayData(gatewayScope, "node.list", "{}")
      val nodesRoot = json.parseToJsonElement(nodesRes).asObjectOrNull()
      val nodes = parseGatewayNodeList(nodesRoot)
      val selfNodeId = identityStore.loadOrCreate().deviceId
      val approval =
        currentNodeCapabilityApproval(
          nodes = nodes,
          selfNodeId = selfNodeId,
        )
      val selfNodeConnected = nodes.firstOrNull { it.id == selfNodeId }?.connected == true
      var approvalPublished = false
      val scopePublished =
        publishGatewayData(gatewayScope) {
          approvalPublished =
            nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
              _nodeCapabilityApproval.value = approval
            }
        }
      if (!scopePublished || !approvalPublished) {
        return
      }
      publishGatewayData(gatewayScope) {
        if (selfNodeConnected && !_nodeConnected.value) {
          updateStatus {
            nodeConnectionProblem = null
            _nodeConnected.value = true
            nodeStatusText = "Connected"
          }
        }
      }
      scheduleNodeApprovalCommandRefresh(gatewayScope, refreshGeneration, approval)
      val devicesRoot =
        if (_devicePairingCapabilities.value.canList) {
          try {
            val devicesRes = requestGatewayData(gatewayScope, "device.pair.list", "{}")
            json.parseToJsonElement(devicesRes).asObjectOrNull()
          } catch (_: Throwable) {
            null
          }
        } else {
          null
        }
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesSummary.value =
            GatewayNodesDevicesSummary(
              nodes = nodes,
              pendingDevices = parsePendingDevices(devicesRoot?.get("pending") as? JsonArray),
              pairedDevices = parsePairedDevices(devicesRoot?.get("paired") as? JsonArray),
              devicePairingAvailable = devicesRoot != null,
            )
        }
      }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesErrorText.value = nativeText("Could not load nodes and devices.")
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
          _nodesDevicesRefreshing.value = false
        }
      }
    }
  }

  private fun scheduleNodeApprovalCommandRefresh(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    approval: GatewayNodeCapabilityApproval,
  ) {
    val fallback = approval.withoutExactRequestId() ?: return
    scope.launch {
      delay(NODE_APPROVAL_COMMAND_FRESH_MS)
      // Pairing request IDs expire on the Gateway. Age out cached commands before rechecking so
      // recovery never leaves an old exact ID visible when a refresh fails or races disconnect.
      var approvalPublished = false
      val scopePublished =
        publishGatewayData(gatewayScope) {
          approvalPublished =
            nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
              _nodeCapabilityApproval.value = fallback
              _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
            }
        }
      if (scopePublished && approvalPublished && operatorConnected) {
        refreshNodesDevicesFromGateway()
      }
    }
  }

  private suspend fun refreshExecApprovalsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    val refreshGeneration =
      synchronized(execApprovalsStateLock) {
        execApprovalsRefreshSeq.incrementAndGet()
      }
    publishGatewayData(gatewayScope) {
      _execApprovalsRefreshing.value = true
      _execApprovalsErrorText.value = null
      // The terminal notice reports an outcome the reviewer has not acknowledged yet.
      // Refresh must not wipe it; it clears on user dismissal, a replacement terminal
      // notice, a re-requested approval with the same id, or gateway teardown.
    }
    if (!operatorConnected) {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovals.value = emptyList()
          _execApprovalsRefreshing.value = false
        }
      }
      return
    }
    try {
      // TODO(#103505): replace legacy full-request discovery with the sanitized
      // session approval lifecycle projection before removing this list seam.
      val res = requestGatewayData(gatewayScope, "exec.approval.list", "{}")
      val existing = _execApprovals.value.associateBy { it.id }
      val terminalApprovals = mutableListOf<GatewayExecApprovalSnapshot.Terminal>()
      val rows =
        parseGatewayExecApprovalListPayload(res, json)
          .filterNot { it.id in resolvedExecApprovalIds }
          .mapNotNull { row ->
            val methodsSnapshot = captureGatewayMethods()
            val lookup =
              try {
                fetchExecApprovalDetailFromGateway(
                  gatewayScope = gatewayScope,
                  methodsSnapshot = methodsSnapshot,
                  id = row.id,
                  createdAtMs = row.createdAtMs ?: System.currentTimeMillis(),
                )
              } catch (_: Throwable) {
                null
              }
            if (lookup is GatewayExecApprovalSnapshot.Terminal) {
              terminalApprovals.add(lookup)
              return@mapNotNull null
            }
            val hydrated =
              (lookup as? GatewayExecApprovalSnapshot.Pending)?.summary
                ?: row.copy(errorText = execApprovalLoadDetailsFailureMessage())
            val current = existing[row.id]
            val pendingWrite = pendingExecApprovalWrite(row.id, gatewayScope.stableId)
            if (current == null) {
              hydrated.copy(
                resolvingDecision = pendingWrite?.decision,
                errorText = if (pendingWrite == null) hydrated.errorText else execApprovalOutcomeUnknownMessage(),
              )
            } else {
              hydrated.copy(
                resolvingDecision = current.resolvingDecision ?: pendingWrite?.decision,
                errorText =
                  current.errorText
                    ?: if (pendingWrite?.requestInFlight == false) {
                      execApprovalOutcomeUnknownMessage()
                    } else {
                      hydrated.errorText
                    },
              )
            }
          }
      publishExecApprovalsIfCurrent(
        gatewayScope = gatewayScope,
        refreshGeneration = refreshGeneration,
        rows = rows,
        terminalApprovals = terminalApprovals,
      )
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovalsErrorText.value = execApprovalLoadFailureMessage()
        }
      }
    } finally {
      publishGatewayData(gatewayScope) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration) {
          _execApprovalsRefreshing.value = false
        }
      }
    }
    reconcilePendingExecApprovalWrites(gatewayScope)
  }

  private suspend fun refreshExecApprovalFromGateway(id: String) {
    val gatewayScope = captureGatewayDataScope() ?: return
    if (!operatorConnected) return
    if (id in resolvedExecApprovalIds) return
    try {
      val current = _execApprovals.value.firstOrNull { it.id == id }
      val methodsSnapshot = captureGatewayMethods()
      val lookup =
        fetchExecApprovalDetailFromGateway(
          gatewayScope = gatewayScope,
          methodsSnapshot = methodsSnapshot,
          id = id,
          createdAtMs = current?.createdAtMs ?: System.currentTimeMillis(),
        )
      when (lookup) {
        is GatewayExecApprovalSnapshot.Pending ->
          publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
            if (id !in resolvedExecApprovalIds) {
              invalidateExecApprovalRefreshes()
              val pendingWrite = pendingExecApprovalWrite(id, gatewayScope.stableId)
              upsertExecApproval(
                lookup.summary.copy(
                  resolvingDecision = current?.resolvingDecision ?: pendingWrite?.decision,
                  errorText =
                    current?.errorText
                      ?: pendingWrite
                        ?.takeIf { current == null || !it.requestInFlight }
                        ?.let { execApprovalOutcomeUnknownMessage() },
                ),
              )
            }
          }
        is GatewayExecApprovalSnapshot.Terminal ->
          publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
            if (_execApprovals.value.any { it.id == id }) {
              _execApprovalsNotice.value = gatewayExecApprovalRemoteTerminalNotice(lookup)
            }
            markExecApprovalResolved(id)
          }
      }
    } catch (_: Throwable) {
      if (isGatewayDataScopeCurrent(gatewayScope)) {
        refreshExecApprovalsFromGateway()
      }
    }
  }

  private suspend fun fetchExecApprovalDetailFromGateway(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    id: String,
    createdAtMs: Long?,
  ): GatewayExecApprovalSnapshot =
    when (methodsSnapshot.approvalRpcFamily) {
      GatewayApprovalRpcFamily.Canonical ->
        fetchUnifiedExecApprovalDetail(
          gatewayScope = gatewayScope,
          methodsSnapshot = methodsSnapshot,
          id = id,
        )
      GatewayApprovalRpcFamily.Legacy -> {
        val params = buildGatewayExecApprovalGetParams(id).toString()
        val response =
          requestGatewayApprovalData(
            gatewayScope = gatewayScope,
            methodsSnapshot = methodsSnapshot,
            method = "exec.approval.get",
            paramsJson = params,
          )
        parseLegacyGatewayExecApprovalGetPayload(
          payloadJson = response,
          json = json,
          expectedId = id,
          createdAtMs = createdAtMs,
        ) ?: error("Malformed exec.approval.get response")
      }
      GatewayApprovalRpcFamily.Unavailable -> throw GatewayApprovalRpcUnavailable()
    }

  private suspend fun resolveExecApprovalOnGateway(
    id: String,
    decision: String,
  ) {
    val gatewayScope = captureGatewayDataScope() ?: return
    val methodsSnapshot = captureGatewayMethods()
    var registeredWrite: PendingExecApprovalWrite? = null
    val scopeCurrent =
      publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
        synchronized(execApprovalsStateLock) {
          if (!operatorConnected || id in resolvedExecApprovalIds) return@synchronized
          val currentRows = _execApprovals.value
          if (currentRows.none { it.id == id && it.resolvingDecision == null }) return@synchronized
          if (pendingExecApprovalWrites.containsKey(id)) return@synchronized
          val pendingWrite =
            PendingExecApprovalWrite(
              gatewayScope.stableId,
              id,
              decision,
              currentRows.firstOrNull { it.id == id }?.createdAtMs,
            )
          pendingExecApprovalWrites[id] = pendingWrite
          registeredWrite = pendingWrite
          invalidateExecApprovalRefreshes()
          _execApprovals.value =
            currentRows.map { row ->
              if (row.id == id) row.copy(resolvingDecision = decision, errorText = null) else row
            }
          // Do not clear the notice here: it reports a different approval's terminal
          // outcome (a same-id write cannot start after its terminal notice retired the
          // row) and must stay visible until the user acknowledges it.
        }
      }
    val pendingWrite = registeredWrite
    if (!scopeCurrent || pendingWrite == null) return
    try {
      val resolution = submitExecApprovalResolution(gatewayScope, methodsSnapshot, id, decision)
      markExecApprovalWriteRequestFinished(pendingWrite)
      publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
        synchronized(execApprovalsStateLock) {
          if (pendingExecApprovalWrites[id] !== pendingWrite || id in resolvedExecApprovalIds) return@synchronized
          // `applied=false` carries the canonical winner from another surface.
          _execApprovalsNotice.value = gatewayExecApprovalResolutionNotice(resolution)
          markExecApprovalResolved(id)
        }
      }
      if (pendingExecApprovalWrite(id, gatewayScope.stableId) === pendingWrite) {
        reconcileExecApprovalWriteOutcome(gatewayScope, pendingWrite)
      }
    } catch (err: CancellationException) {
      markExecApprovalWriteRequestFinished(pendingWrite)
      reconcileExecApprovalWriteOutcome(gatewayScope, pendingWrite)
      throw err
    } catch (_: GatewayRequestNotEnqueued) {
      handleExecApprovalResolveFailure(
        gatewayScope = gatewayScope,
        pendingWrite = pendingWrite,
        outcomeUnknown = false,
      )
    } catch (err: GatewayRequestRejected) {
      if (
        methodsSnapshot.approvalRpcFamily == GatewayApprovalRpcFamily.Legacy &&
        isGatewayExecApprovalAlreadyResolved(err.gatewayError)
      ) {
        // Mirror the success path: the rejection settled the request, so mark it
        // finished first. The epoch-guarded publish below can be skipped by a methods
        // epoch bump, and a write left requestInFlight would never reconcile.
        markExecApprovalWriteRequestFinished(pendingWrite)
        handleLegacyExecApprovalAlreadyResolved(gatewayScope, methodsSnapshot, pendingWrite)
        if (pendingExecApprovalWrite(id, gatewayScope.stableId) === pendingWrite) {
          // A same-endpoint method-catalog replacement rejects stale publishes but does
          // not invalidate the write owner. Read current canonical state so the card
          // cannot remain frozen until a later manual refresh.
          reconcileExecApprovalWriteOutcome(gatewayScope, pendingWrite)
        }
      } else {
        handleExecApprovalResolveFailure(
          gatewayScope = gatewayScope,
          pendingWrite = pendingWrite,
          outcomeUnknown = false,
        )
      }
    } catch (_: GatewayApprovalRpcUnavailable) {
      handleExecApprovalResolveFailure(
        gatewayScope = gatewayScope,
        pendingWrite = pendingWrite,
        outcomeUnknown = false,
      )
    } catch (_: Throwable) {
      handleExecApprovalResolveFailure(
        gatewayScope = gatewayScope,
        pendingWrite = pendingWrite,
        outcomeUnknown = true,
      )
      reconcileExecApprovalWriteOutcome(gatewayScope, pendingWrite)
    }
  }

  private suspend fun submitExecApprovalResolution(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    id: String,
    decision: String,
  ): GatewayExecApprovalResolution =
    when (methodsSnapshot.approvalRpcFamily) {
      GatewayApprovalRpcFamily.Canonical -> {
        val params = buildGatewayExecApprovalResolveParams(id, decision).toString()
        val response =
          requestGatewayApprovalData(
            gatewayScope = gatewayScope,
            methodsSnapshot = methodsSnapshot,
            method = "approval.resolve",
            paramsJson = params,
            preserveWriteFailureAcrossEpoch = true,
          )
        parseGatewayExecApprovalResolvePayload(
          payloadJson = response,
          json = json,
          expectedId = id,
          expectedDecision = decision,
        ) ?: throw ExecApprovalWriteOutcomeUnknown()
      }
      GatewayApprovalRpcFamily.Legacy -> {
        val legacyParams =
          buildJsonObject {
            put("id", JsonPrimitive(id))
            put("decision", JsonPrimitive(decision))
          }.toString()
        val legacyResponse =
          requestGatewayApprovalData(
            gatewayScope = gatewayScope,
            methodsSnapshot = methodsSnapshot,
            method = "exec.approval.resolve",
            paramsJson = legacyParams,
            preserveWriteFailureAcrossEpoch = true,
          )
        if (!parseLegacyGatewayExecApprovalResolvePayload(legacyResponse, json)) {
          throw ExecApprovalWriteOutcomeUnknown()
        }
        val terminal =
          legacyGatewayExecApprovalTerminal(id, decision)
            ?: throw ExecApprovalWriteOutcomeUnknown()
        GatewayExecApprovalResolution(
          applied = false,
          approval = terminal,
          attribution = GatewayExecApprovalResolutionAttribution.Unknown,
        )
      }
      GatewayApprovalRpcFamily.Unavailable -> throw GatewayApprovalRpcUnavailable()
    }

  private fun isGatewayExecApprovalAlreadyResolved(error: GatewaySession.ErrorShape): Boolean = error.code == "INVALID_REQUEST" && error.details?.reason == "APPROVAL_ALREADY_RESOLVED"

  private fun handleLegacyExecApprovalAlreadyResolved(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    pendingWrite: PendingExecApprovalWrite,
  ) {
    publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
      synchronized(execApprovalsStateLock) {
        val id = pendingWrite.id
        if (pendingExecApprovalWrites[id] !== pendingWrite) return@synchronized
        if (_execApprovals.value.any { it.id == id }) {
          _execApprovalsNotice.value = gatewayExecApprovalPriorResolutionNotice(id)
        }
        // The legacy rejection proves only that another verdict won. Retire the
        // exact card without inventing that unavailable winner's decision.
        markExecApprovalResolved(id)
      }
    }
  }

  private fun handleExecApprovalResolveFailure(
    gatewayScope: GatewayDataScope,
    pendingWrite: PendingExecApprovalWrite,
    outcomeUnknown: Boolean,
  ) {
    publishGatewayData(gatewayScope) {
      synchronized(execApprovalsStateLock) {
        val id = pendingWrite.id
        if (pendingExecApprovalWrites[id] !== pendingWrite) return@synchronized
        if (!outcomeUnknown) {
          pendingExecApprovalWrites.remove(id)
        } else {
          pendingWrite.requestInFlight = false
        }
        invalidateExecApprovalRefreshes()
        if (!operatorConnected || id in resolvedExecApprovalIds || _execApprovals.value.none { it.id == id }) {
          return@synchronized
        }
        val error =
          if (outcomeUnknown) execApprovalOutcomeUnknownMessage() else execApprovalResolveFailureMessage()
        _execApprovals.value =
          _execApprovals.value.map { row ->
            if (row.id == id) {
              row.copy(
                resolvingDecision = pendingWrite.decision.takeIf { outcomeUnknown },
                errorText = error,
              )
            } else {
              row
            }
          }
      }
    }
  }

  private suspend fun reconcilePendingExecApprovalWrites(gatewayScope: GatewayDataScope) {
    if (!operatorConnected) return
    val pendingWrites =
      synchronized(execApprovalsStateLock) {
        pendingExecApprovalWrites.values
          .filter { it.stableId == gatewayScope.stableId && !it.requestInFlight }
          .toList()
      }
    pendingWrites.forEach { reconcileExecApprovalWriteOutcome(gatewayScope, it) }
  }

  private suspend fun reconcileExecApprovalWriteOutcome(
    gatewayScope: GatewayDataScope,
    pendingWrite: PendingExecApprovalWrite,
  ) {
    val shouldReconcile =
      synchronized(execApprovalsStateLock) {
        operatorConnected &&
          pendingExecApprovalWrites[pendingWrite.id] === pendingWrite &&
          !pendingWrite.requestInFlight
      }
    if (!shouldReconcile) return
    val methodsSnapshot = captureGatewayMethods()
    val snapshot =
      try {
        fetchExecApprovalDetailFromGateway(
          gatewayScope = gatewayScope,
          methodsSnapshot = methodsSnapshot,
          id = pendingWrite.id,
          createdAtMs =
            pendingWrite.createdAtMs
              ?: _execApprovals.value.firstOrNull { it.id == pendingWrite.id }?.createdAtMs,
        )
      } catch (_: Throwable) {
        return
      }
    publishGatewayApprovalData(gatewayScope, methodsSnapshot) {
      synchronized(execApprovalsStateLock) {
        if (!operatorConnected || pendingExecApprovalWrites[pendingWrite.id] !== pendingWrite) return@synchronized
        when (snapshot) {
          is GatewayExecApprovalSnapshot.Terminal -> {
            _execApprovalsNotice.value = gatewayExecApprovalRemoteTerminalNotice(snapshot)
            markExecApprovalResolved(pendingWrite.id)
          }
          is GatewayExecApprovalSnapshot.Pending -> {
            invalidateExecApprovalRefreshes()
            pendingExecApprovalWrites.remove(pendingWrite.id)
            val row =
              snapshot.summary.copy(
                resolvingDecision = null,
                errorText = execApprovalStillPendingMessage(),
              )
            val retained = _execApprovals.value.filterNot { it.id == pendingWrite.id }
            val nextRows =
              (retained + row)
                .filterActiveExecApprovals()
                .sortedBy { it.createdAtMs ?: Long.MAX_VALUE }
            _execApprovals.value = nextRows
            scheduleExecApprovalExpiryPrune(nextRows)
          }
        }
      }
    }
  }

  private fun markExecApprovalWriteRequestFinished(pendingWrite: PendingExecApprovalWrite) {
    synchronized(execApprovalsStateLock) {
      if (pendingExecApprovalWrites[pendingWrite.id] === pendingWrite) {
        pendingWrite.requestInFlight = false
      }
    }
  }

  private suspend fun fetchUnifiedExecApprovalDetail(
    gatewayScope: GatewayDataScope,
    methodsSnapshot: GatewayMethodsSnapshot,
    id: String,
  ): GatewayExecApprovalSnapshot {
    val params = buildGatewayExecApprovalGetParams(id).toString()
    val response =
      requestGatewayApprovalData(
        gatewayScope = gatewayScope,
        methodsSnapshot = methodsSnapshot,
        method = "approval.get",
        paramsJson = params,
      )
    return parseGatewayExecApprovalGetPayload(response, json, expectedId = id)
      ?: error("Malformed approval.get response")
  }

  private fun replaceGatewayMethods(methods: Set<String>) {
    synchronized(gatewayMethodsLock) {
      gatewayApprovalRpcFamily = selectGatewayApprovalRpcFamily(methods)
      _clawHubSkillMethodsAvailable.value = supportsClawHubSkillManagement(methods)
      gatewayMethodsEpoch += 1
    }
  }

  private fun captureGatewayMethods(): GatewayMethodsSnapshot =
    synchronized(gatewayMethodsLock) {
      GatewayMethodsSnapshot(
        approvalRpcFamily = gatewayApprovalRpcFamily,
        epoch = gatewayMethodsEpoch,
      )
    }

  private fun isGatewayMethodsSnapshotCurrent(snapshot: GatewayMethodsSnapshot): Boolean = synchronized(gatewayMethodsLock) { snapshot.epoch == gatewayMethodsEpoch }

  private fun pendingExecApprovalWrite(
    id: String,
    stableId: String,
  ): PendingExecApprovalWrite? =
    synchronized(execApprovalsStateLock) {
      pendingExecApprovalWrites[id]?.takeIf { it.stableId == stableId }
    }

  private fun upsertExecApproval(row: GatewayExecApprovalSummary) {
    synchronized(execApprovalsStateLock) {
      if (!operatorConnected || row.id in resolvedExecApprovalIds) return
      if (row.isExpiredExecApproval()) return
      val rows = _execApprovals.value
      val replaced = rows.any { it.id == row.id }
      val nextRows =
        (
          if (replaced) {
            rows.map { current ->
              if (current.id == row.id) {
                row.copy(
                  resolvingDecision = current.resolvingDecision ?: row.resolvingDecision,
                  errorText = current.errorText ?: row.errorText,
                )
              } else {
                current
              }
            }
          } else {
            rows + row
          }
        ).filterActiveExecApprovals()
          .sortedBy { it.createdAtMs ?: Long.MAX_VALUE }
      _execApprovals.value = nextRows
      scheduleExecApprovalExpiryPrune(nextRows)
    }
  }

  private fun invalidateExecApprovalRefreshes() {
    synchronized(execApprovalsStateLock) {
      execApprovalsRefreshSeq.incrementAndGet()
      _execApprovalsRefreshing.value = false
    }
  }

  private fun markExecApprovalResolved(id: String) {
    synchronized(execApprovalsStateLock) {
      resolvedExecApprovalIds.add(id)
      pendingExecApprovalWrites.remove(id)
      invalidateExecApprovalRefreshes()
      _execApprovals.value = _execApprovals.value.filterNot { it.id == id }
    }
  }

  private fun publishExecApprovalsIfCurrent(
    gatewayScope: GatewayDataScope,
    refreshGeneration: Long,
    rows: List<GatewayExecApprovalSummary>,
    terminalApprovals: List<GatewayExecApprovalSnapshot.Terminal>,
  ) {
    publishGatewayData(gatewayScope) {
      synchronized(execApprovalsStateLock) {
        if (execApprovalsRefreshSeq.get() == refreshGeneration && operatorConnected) {
          val visibleIds = _execApprovals.value.mapTo(mutableSetOf()) { it.id }
          val pendingWriteIds =
            pendingExecApprovalWrites.values
              .filter { it.stableId == gatewayScope.stableId }
              .mapTo(mutableSetOf()) { it.id }
          terminalApprovals.lastOrNull { it.id in visibleIds || it.id in pendingWriteIds }?.let { terminal ->
            _execApprovalsNotice.value = gatewayExecApprovalRemoteTerminalNotice(terminal)
          }
          val terminalIds = terminalApprovals.map { it.id }
          resolvedExecApprovalIds.addAll(terminalIds)
          terminalIds.forEach(pendingExecApprovalWrites::remove)
          val nextRows = rows.filterNot { it.id in resolvedExecApprovalIds }.filterActiveExecApprovals()
          _execApprovals.value = nextRows
          scheduleExecApprovalExpiryPrune(nextRows)
        }
      }
    }
  }

  private fun scheduleExecApprovalExpiryPrune(rows: List<GatewayExecApprovalSummary>) {
    val now = System.currentTimeMillis()
    val nextExpiry = rows.mapNotNull { it.expiresAtMs }.filter { it > now }.minOrNull() ?: return
    scope.launch {
      delay((nextExpiry - now + 250).coerceAtLeast(0))
      pruneExpiredExecApprovals()
    }
  }

  private fun pruneExpiredExecApprovals() {
    synchronized(execApprovalsStateLock) {
      _execApprovals.value = _execApprovals.value.filterActiveExecApprovals()
    }
  }

  private fun GatewayExecApprovalSummary.isExpiredExecApproval(nowMs: Long = System.currentTimeMillis()): Boolean = expiresAtMs?.let { it <= nowMs } == true

  private fun List<GatewayExecApprovalSummary>.filterActiveExecApprovals(
    nowMs: Long = System.currentTimeMillis(),
  ): List<GatewayExecApprovalSummary> = filterNot { it.isExpiredExecApproval(nowMs) }

  private fun invalidateNodeCapabilityApprovalState() {
    val refreshGeneration = nodeApprovalRefreshGuard.begin()
    nodeApprovalRefreshGuard.publishIfCurrent(refreshGeneration) {
      _nodeCapabilityApproval.value = GatewayNodeCapabilityApproval.Loading
      _nodesDevicesSummary.value = _nodesDevicesSummary.value.withoutExactApprovalRequestIds()
      _nodesDevicesRefreshing.value = false
    }
  }

  private suspend fun refreshChannelsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _channelsRefreshing.value = true
      _channelsErrorText.value = null
    }
    if (!operatorConnected) {
      _channelsSummary.value = GatewayChannelsSummary(channels = emptyList())
      _channelsRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "channels.status", """{"probe":false,"timeoutMs":8000}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val summary =
        GatewayChannelsSummary(
          updatedAtMs = root.long("ts"),
          partial = root.boolean("partial"),
          warnings = parseStringArray(root?.get("warnings") as? JsonArray),
          channels = parseChannelSummaries(root),
        )
      publishGatewayData(gatewayScope) { _channelsSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _channelsErrorText.value = nativeText("Could not load channels.") }
    } finally {
      publishGatewayData(gatewayScope) { _channelsRefreshing.value = false }
    }
  }

  private suspend fun refreshDreamingFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _dreamingRefreshing.value = true
      _dreamingErrorText.value = null
    }
    if (!operatorConnected) {
      _dreamingSummary.value = GatewayDreamingSummary()
      _dreamingRefreshing.value = false
      return
    }
    try {
      val statusRes = requestGatewayData(gatewayScope, "doctor.memory.status", "{}")
      val statusRoot = json.parseToJsonElement(statusRes).asObjectOrNull()
      val diaryRes = requestGatewayData(gatewayScope, "doctor.memory.dreamDiary", "{}")
      val diaryRoot = json.parseToJsonElement(diaryRes).asObjectOrNull()
      val dreaming = statusRoot?.get("dreaming").asObjectOrNull()
      val summary =
        parseDreamingSummary(
          dreaming = dreaming,
          diary = diaryRoot,
        )
      publishGatewayData(gatewayScope) { _dreamingSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _dreamingErrorText.value = nativeText("Could not load dreaming.") }
    } finally {
      publishGatewayData(gatewayScope) { _dreamingRefreshing.value = false }
    }
  }

  private suspend fun refreshHealthLogsFromGateway() {
    val gatewayScope = captureGatewayDataScope() ?: return
    publishGatewayData(gatewayScope) {
      _healthLogsRefreshing.value = true
      _healthLogsErrorText.value = null
    }
    if (!operatorConnected) {
      _healthLogsSummary.value = GatewayHealthLogsSummary()
      _healthLogsRefreshing.value = false
      return
    }
    try {
      val res = requestGatewayData(gatewayScope, "logs.tail", """{"limit":40,"maxBytes":65536}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val lines = (root?.get("lines") as? JsonArray)?.mapNotNull { it.asStringOrNull() }.orEmpty()
      val summary =
        GatewayHealthLogsSummary(
          fileName =
            root
              ?.get("file")
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?.substringAfterLast('/')
              ?.substringAfterLast('\\'),
          cursor = root.long("cursor"),
          truncated = root.boolean("truncated"),
          entries = lines.map { parseGatewayLogEntry(it) },
        )
      publishGatewayData(gatewayScope) { _healthLogsSummary.value = summary }
    } catch (_: Throwable) {
      publishGatewayData(gatewayScope) { _healthLogsErrorText.value = nativeText("Could not load gateway logs.") }
    } finally {
      publishGatewayData(gatewayScope) { _healthLogsRefreshing.value = false }
    }
  }

  private fun parseGatewayLogEntry(line: String): GatewayLogEntry {
    val sanitizedLine = sanitizeGatewayLogText(line)
    val root =
      try {
        json.parseToJsonElement(line).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return GatewayLogEntry(
        time = null,
        level = null,
        subsystem = null,
        message = sanitizedLine.trim().ifEmpty { "Empty log entry" },
        raw = sanitizedLine,
      )
    val meta = root["_meta"].asObjectOrNull()
    val time = root["time"].asStringOrNull() ?: meta?.get("date").asStringOrNull()
    val level = normalizeLogLevel(meta?.get("logLevelName").asStringOrNull() ?: meta?.get("level").asStringOrNull())
    val contextCandidate = root["0"].asStringOrNull() ?: meta?.get("name").asStringOrNull()
    val contextObject = parseMaybeJsonObject(contextCandidate)
    val subsystem =
      contextObject?.get("subsystem").asStringOrNull()
        ?: contextObject?.get("module").asStringOrNull()
        ?: contextCandidate?.takeIf { it.length < 80 && contextObject == null }
    val contextMessage = if (contextObject == null) root["0"].asStringOrNull() else null
    val message =
      root["1"].asStringOrNull()
        ?: root["2"].asStringOrNull()
        ?: contextMessage
        ?: root["message"].asStringOrNull()
        ?: line
    val normalizedMessage =
      sanitizeGatewayLogText(message)
        .trim()
        .replace(Regex("\\s+"), " ")
        .takeUtf16Safe(240)
        .ifEmpty { "Log entry" }
    return GatewayLogEntry(
      time = time,
      level = level,
      subsystem = subsystem?.let(::sanitizeGatewayLogText)?.trim()?.takeIf { it.isNotEmpty() },
      message = normalizedMessage,
      raw = sanitizedLine,
    )
  }

  private fun parseMaybeJsonObject(value: String?): JsonObject? {
    val trimmed = value?.trim().orEmpty()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
    return try {
      json.parseToJsonElement(trimmed).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun normalizeLogLevel(value: String?): String? {
    val level = value?.trim()?.lowercase().orEmpty()
    return if (level in setOf("trace", "debug", "info", "warn", "error", "fatal")) level else null
  }

  private fun parseGatewayModelProviders(providers: JsonArray?): List<GatewayModelProviderSummary> =
    providers
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj["provider"].asStringOrNull()?.trim().orEmpty()
        if (id.isEmpty()) return@mapNotNull null
        GatewayModelProviderSummary(
          id = id,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: providerDisplayName(id),
          status = obj["status"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown",
          profileCount = ((obj["profiles"] as? JsonArray)?.size ?: 0),
        )
      }.orEmpty()

  private fun parseCronJobs(jobs: JsonArray?): List<GatewayCronJobSummary> =
    jobs
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj["id"].asStringOrNull()?.trim().orEmpty()
        val name = obj["name"].asStringOrNull()?.trim().orEmpty()
        if (id.isEmpty() || name.isEmpty()) return@mapNotNull null
        val schedule = obj["schedule"].asObjectOrNull()
        val state = obj["state"].asObjectOrNull()
        val payload = obj["payload"].asObjectOrNull()
        GatewayCronJobSummary(
          id = id,
          name = name,
          enabled = obj.boolean("enabled"),
          scheduleLabel = cronScheduleLabel(schedule),
          promptPreview = cronPayloadPreview(payload),
          nextRunAtMs = state.long("nextRunAtMs"),
          lastRunStatus = cronJobLastRunStatus(state),
        )
      }.orEmpty()

  private fun parseUsageProviders(providers: JsonArray?): List<GatewayUsageProviderSummary> =
    providers
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val displayName = obj["displayName"].asStringOrNull()?.trim().orEmpty()
        if (displayName.isEmpty()) return@mapNotNull null
        GatewayUsageProviderSummary(
          displayName = displayName,
          plan = obj["plan"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          error = obj["error"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          windows = parseUsageWindows(obj["windows"] as? JsonArray),
        )
      }.orEmpty()

  private fun parseUsageWindows(windows: JsonArray?): List<GatewayUsageWindowSummary> =
    windows
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val label = obj["label"].asStringOrNull()?.trim().orEmpty()
        if (label.isEmpty()) return@mapNotNull null
        GatewayUsageWindowSummary(
          label = label,
          usedPercent = obj.double("usedPercent") ?: 0.0,
          resetAtMs = obj.long("resetAt"),
        )
      }.orEmpty()

  private fun parseSkillSummaries(skills: JsonArray?): List<GatewaySkillSummary> =
    skills
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val name = obj["name"].asStringOrNull()?.trim().orEmpty()
        if (name.isEmpty()) return@mapNotNull null
        val missing = obj["missing"].asObjectOrNull()
        val clawHub = obj["clawhub"].asObjectOrNull()
        GatewaySkillSummary(
          skillKey = obj["skillKey"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: name,
          name = name,
          description = obj["description"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          source = obj["source"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "unknown",
          emoji = obj["emoji"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          disabled = obj.boolean("disabled"),
          eligible = obj.boolean("eligible"),
          blockedByAllowlist = obj.boolean("blockedByAllowlist"),
          blockedByAgentFilter = obj.boolean("blockedByAgentFilter"),
          bundled = obj.boolean("bundled"),
          missingCount = skillMissingCount(missing),
          installCount = (obj["install"] as? JsonArray)?.size ?: 0,
          clawHubSlug =
            clawHub
              ?.get("slug")
              .asStringOrNull()
              ?.trim()
              ?.takeIf(String::isNotEmpty),
          clawHubValid = clawHub?.boolean("valid") == true,
          clawHubOwnerHandle =
            clawHub
              ?.get("ownerHandle")
              .asStringOrNull()
              ?.trim()
              ?.takeIf(String::isNotEmpty),
          clawHubInstalledVersion =
            clawHub
              ?.get("installedVersion")
              .asStringOrNull()
              ?.trim()
              ?.takeIf(String::isNotEmpty),
        )
      }.orEmpty()

  private fun parseSkillWorkshopProposals(
    proposals: JsonArray?,
    previousById: Map<String, GatewaySkillWorkshopProposal>,
  ): List<GatewaySkillWorkshopProposal> {
    val parsed =
      proposals?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val id = obj.skillWorkshopString("id") ?: return@mapNotNull null
        val previous = previousById[id]
        val updatedAt = obj.skillWorkshopString("updatedAt").orEmpty()
        GatewaySkillWorkshopProposal(
          id = id,
          kind = obj.skillWorkshopString("kind") ?: "proposal",
          status = obj.skillWorkshopString("status") ?: "pending",
          title = obj.skillWorkshopString("title") ?: obj.skillWorkshopString("skillName") ?: id,
          description = obj.skillWorkshopString("description"),
          skillName = obj.skillWorkshopString("skillName") ?: id,
          skillKey = obj.skillWorkshopString("skillKey") ?: id,
          createdAt = obj.skillWorkshopString("createdAt").orEmpty(),
          updatedAt = updatedAt,
          scanState = obj.skillWorkshopString("scanState"),
          content = previous?.content?.takeIf { previous.updatedAt == updatedAt },
          supportFiles = previous?.supportFiles?.takeIf { previous.updatedAt == updatedAt }.orEmpty(),
        )
      }
    return parsed.orEmpty().sortedByDescending { it.updatedAt }
  }

  private fun parseSkillWorkshopProposalInspect(
    root: JsonObject?,
    previous: GatewaySkillWorkshopProposal?,
  ): GatewaySkillWorkshopProposal? {
    val source = root ?: return null
    val record = source["record"].asObjectOrNull() ?: return null
    val id = record.skillWorkshopString("id") ?: previous?.id ?: return null
    val target = record["target"].asObjectOrNull()
    val updatedAt = record.skillWorkshopString("updatedAt").orEmpty()
    return GatewaySkillWorkshopProposal(
      id = id,
      kind = record.skillWorkshopString("kind") ?: previous?.kind ?: "proposal",
      status = record.skillWorkshopString("status") ?: previous?.status ?: "pending",
      title = record.skillWorkshopString("title") ?: target?.skillWorkshopString("skillName") ?: previous?.title ?: id,
      description = record.skillWorkshopString("description") ?: previous?.description,
      skillName = target?.skillWorkshopString("skillName") ?: previous?.skillName ?: id,
      skillKey = target?.skillWorkshopString("skillKey") ?: previous?.skillKey ?: id,
      createdAt = record.skillWorkshopString("createdAt") ?: previous?.createdAt.orEmpty(),
      updatedAt = updatedAt.ifEmpty { previous?.updatedAt.orEmpty() },
      scanState = record.skillWorkshopString("scanState") ?: previous?.scanState,
      content = stripSkillWorkshopFrontmatter(source["content"].asStringOrNull().orEmpty()),
      supportFiles = parseSkillWorkshopSupportFiles(source["supportFiles"] as? JsonArray),
    )
  }

  private fun parseSkillWorkshopProposalActionResult(
    root: JsonObject?,
    previous: GatewaySkillWorkshopProposal?,
  ): GatewaySkillWorkshopProposal? {
    val record =
      root?.get("record").asObjectOrNull()
        ?: root?.takeIf { it.skillWorkshopString("status") != null }
        ?: return null
    val id = record.skillWorkshopString("id") ?: previous?.id ?: return null
    val target = record["target"].asObjectOrNull()
    val updatedAt = record.skillWorkshopString("updatedAt").orEmpty()
    return GatewaySkillWorkshopProposal(
      id = id,
      kind = record.skillWorkshopString("kind") ?: previous?.kind ?: "proposal",
      status = record.skillWorkshopString("status") ?: previous?.status ?: "pending",
      title = record.skillWorkshopString("title") ?: target?.skillWorkshopString("skillName") ?: previous?.title ?: id,
      description = record.skillWorkshopString("description") ?: previous?.description,
      skillName = target?.skillWorkshopString("skillName") ?: previous?.skillName ?: id,
      skillKey = target?.skillWorkshopString("skillKey") ?: previous?.skillKey ?: id,
      createdAt = record.skillWorkshopString("createdAt") ?: previous?.createdAt.orEmpty(),
      updatedAt = updatedAt.ifEmpty { previous?.updatedAt.orEmpty() },
      scanState =
        record["scan"].asObjectOrNull()?.skillWorkshopString("state")
          ?: record.skillWorkshopString("scanState")
          ?: previous?.scanState,
      content = previous?.content,
      supportFiles = previous?.supportFiles.orEmpty(),
    )
  }

  private fun parseSkillWorkshopSupportFiles(files: JsonArray?): List<GatewaySkillWorkshopSupportFile> {
    val parsed =
      files?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val path = obj.skillWorkshopString("path") ?: return@mapNotNull null
        GatewaySkillWorkshopSupportFile(
          path = path,
          content = obj["content"].asStringOrNull()?.takeIf { it.isNotEmpty() },
        )
      }
    return parsed.orEmpty()
  }

  private fun stripSkillWorkshopFrontmatter(content: String): String {
    val withoutFrontmatter = content.replace(Regex("(?s)^---\\r?\\n.*?\\r?\\n---\\r?\\n?"), "")
    return withoutFrontmatter.trim()
  }

  private fun JsonObject.skillWorkshopString(key: String): String? =
    get(key)
      .asStringOrNull()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

  private fun skillMissingCount(missing: JsonObject?): Int = listOf("bins", "env", "config", "os").sumOf { key -> (missing?.get(key) as? JsonArray)?.size ?: 0 }

  private fun parsePendingDevices(devices: JsonArray?): List<GatewayPendingDeviceSummary> =
    devices
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val requestId = obj["requestId"].asStringOrNull()?.trim().orEmpty()
        val deviceId = obj["deviceId"].asStringOrNull()?.trim().orEmpty()
        if (requestId.isEmpty() || deviceId.isEmpty()) return@mapNotNull null
        GatewayPendingDeviceSummary(
          requestId = requestId,
          deviceId = deviceId,
          publicKey = obj["publicKey"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          platform = obj["platform"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          deviceFamily = obj["deviceFamily"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          clientId = obj["clientId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          clientMode = obj["clientMode"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          browserOrigin = obj["browserOrigin"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          roles = parseDeviceRoles(obj),
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          requestedAtMs = obj.long("ts"),
          repair = obj.boolean("isRepair"),
        )
      }.orEmpty()

  private fun parsePairedDevices(devices: JsonArray?): List<GatewayPairedDeviceSummary> =
    devices
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val deviceId = obj["deviceId"].asStringOrNull()?.trim().orEmpty()
        if (deviceId.isEmpty()) return@mapNotNull null
        GatewayPairedDeviceSummary(
          deviceId = deviceId,
          displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
          roles = parseDeviceRoles(obj),
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          tokens = parseDeviceTokens(obj["tokens"] as? JsonArray),
          approvedAtMs = obj.long("approvedAtMs"),
        )
      }.orEmpty()

  private fun parseDeviceRoles(device: JsonObject): List<String> {
    val roles = parseStringArray(device["roles"] as? JsonArray)
    if (roles.isNotEmpty()) return roles
    return listOfNotNull(device["role"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() })
  }

  private fun parseDeviceTokens(tokens: JsonArray?): List<GatewayDeviceTokenSummary> =
    tokens
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull()?.trim().orEmpty()
        if (role.isEmpty()) return@mapNotNull null
        GatewayDeviceTokenSummary(
          role = role,
          scopes = parseStringArray(obj["scopes"] as? JsonArray),
          revoked = obj.long("revokedAtMs") != null,
          updatedAtMs = obj.long("rotatedAtMs") ?: obj.long("createdAtMs") ?: obj.long("lastUsedAtMs"),
        )
      }.orEmpty()

  private fun parseChannelSummaries(root: JsonObject?): List<GatewayChannelSummary> {
    val order = parseStringArray(root?.get("channelOrder") as? JsonArray)
    val labels = parseStringMap(root?.get("channelLabels").asObjectOrNull())
    val channels = root?.get("channels").asObjectOrNull()
    val accounts = root?.get("channelAccounts").asObjectOrNull()
    val ids = (order + channels.orEmpty().keys + accounts.orEmpty().keys).distinct()
    return ids
      .map { id ->
        val summary = channels?.get(id).asObjectOrNull()
        val accountRows = parseChannelAccounts(accounts?.get(id) as? JsonArray)
        GatewayChannelSummary(
          id = id,
          label = labels[id] ?: channelDisplayLabel(id),
          accountCount = accountRows.size,
          enabled = summary.boolean("enabled") || accountRows.any { it.enabled },
          configured = summary.boolean("configured") || accountRows.any { it.configured },
          linked = summary.boolean("linked") || accountRows.any { it.linked },
          running = summary.boolean("running") || accountRows.any { it.running },
          connected = summary.boolean("connected") || accountRows.any { it.connected },
          error =
            summary
              ?.get("lastError")
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() }
              ?: accountRows.firstNotNullOfOrNull { it.error },
        )
      }.sortedWith(compareByDescending<GatewayChannelSummary> { it.enabled || it.configured }.thenBy { it.label.lowercase() })
  }

  private fun parseChannelAccounts(accounts: JsonArray?): List<GatewayChannelAccountSummary> =
    accounts
      ?.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val accountId = obj["accountId"].asStringOrNull()?.trim().orEmpty()
        if (accountId.isEmpty()) return@mapNotNull null
        GatewayChannelAccountSummary(
          enabled = obj.boolean("enabled"),
          configured = obj.boolean("configured"),
          linked = obj.boolean("linked"),
          running = obj.boolean("running"),
          connected = obj.boolean("connected"),
          error =
            obj["lastError"]
              .asStringOrNull()
              ?.trim()
              ?.takeIf { it.isNotEmpty() },
        )
      }.orEmpty()

  private fun parseStringMap(map: JsonObject?): Map<String, String> =
    map
      ?.mapNotNull { (key, value) ->
        value
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { key to it }
      }?.toMap()
      .orEmpty()

  private fun parseDreamingSummary(
    dreaming: JsonObject?,
    diary: JsonObject?,
  ): GatewayDreamingSummary {
    val diaryContent = diary?.get("content").asStringOrNull()
    val entries = if (diary.boolean("found")) parseDreamDiaryEntries(diaryContent) else emptyList()
    val timezone =
      dreaming
        ?.get("timezone")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    val storeHealthy =
      dreaming
        ?.get("storeError")
        .asStringOrNull()
        ?.trim()
        .isNullOrEmpty()
    val phaseSignalHealthy =
      dreaming
        ?.get("phaseSignalError")
        .asStringOrNull()
        ?.trim()
        .isNullOrEmpty()
    return GatewayDreamingSummary(
      enabled = dreaming.boolean("enabled"),
      timezone = timezone,
      shortTermCount = dreaming.long("shortTermCount")?.toInt() ?: 0,
      groundedSignalCount = dreaming.long("groundedSignalCount")?.toInt() ?: 0,
      totalSignalCount = dreaming.long("totalSignalCount")?.toInt() ?: 0,
      promotedToday = dreaming.long("promotedToday")?.toInt() ?: 0,
      promotedTotal = dreaming.long("promotedTotal")?.toInt() ?: 0,
      nextRunAtMs = dreamingNextRunAtMs(dreaming),
      storeHealthy = storeHealthy,
      phaseSignalHealthy = phaseSignalHealthy,
      diaryFound = diary.boolean("found"),
      diaryEntries = entries,
      diaryEntryCount = entries.size,
    )
  }

  private fun dreamingNextRunAtMs(dreaming: JsonObject?): Long? {
    val phases = dreaming?.get("phases").asObjectOrNull()
    return listOf("light", "deep", "rem")
      .mapNotNull { phase -> phases?.get(phase).asObjectOrNull().long("nextRunAtMs") }
      .minOrNull()
  }

  private fun parseDreamDiaryEntries(content: String?): List<GatewayDreamDiaryEntry> {
    val raw = content?.trim().orEmpty()
    if (raw.isEmpty()) return emptyList()
    val body = raw.substringAfter("<!-- openclaw:dreaming:diary:start -->", raw).substringBefore("<!-- openclaw:dreaming:diary:end -->")
    return body
      .split(Regex("\\n---\\n"))
      .mapNotNull(::parseGatewayDreamDiaryEntry)
      .asReversed()
      .take(4)
  }

  private fun parseStringArray(items: JsonArray?): List<String> =
    items
      ?.mapNotNull { item -> item.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } }
      .orEmpty()

  private fun cronScheduleLabel(schedule: JsonObject?): NativeText =
    when (schedule?.get("kind").asStringOrNull()) {
      "at" -> nativeText("One time")
      "every" -> schedule.long("everyMs")?.let(::cronIntervalText) ?: nativeText("Repeating")
      "cron" ->
        schedule
          ?.get("expr")
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let(::verbatimText)
          ?: nativeText("Cron")
      else -> nativeText("Scheduled")
    }

  private fun cronIntervalText(everyMs: Long): NativeText {
    val minutes = everyMs / 60_000L
    val hours = minutes / 60L
    val days = hours / 24L
    return when {
      days >= 1 && hours % 24L == 0L -> nativeText("Every \${days}d", days)
      hours >= 1 && minutes % 60L == 0L -> nativeText("Every \${hours}h", hours)
      minutes >= 1 -> nativeText("Every \${minutes}m", minutes)
      else -> nativeText("Repeating")
    }
  }

  private fun cronPayloadPreview(payload: JsonObject?): NativeText {
    val text =
      when (payload?.get("kind").asStringOrNull()) {
        "systemEvent" -> payload?.get("text").asStringOrNull()
        "agentTurn" -> payload?.get("message").asStringOrNull()
        else -> null
      }
    return text
      ?.trim()
      ?.replace(Regex("\\s+"), " ")
      ?.takeIf { it.isNotEmpty() }
      ?.let(::verbatimText)
      ?: nativeText("No prompt")
  }

  private fun updateHomeCanvasState() {
    val payload =
      try {
        json.encodeToString(makeHomeCanvasPayload())
      } catch (_: Throwable) {
        null
      }
    canvas.updateHomeCanvasState(payload)
  }

  private fun makeHomeCanvasPayload(): HomeCanvasPayload {
    val state = resolveHomeCanvasGatewayState()
    val gatewayName = normalized(_serverName.value)
    val gatewayAddress = normalized(_remoteAddress.value)
    val gatewayLabel = gatewayName ?: gatewayAddress ?: nativeString("Gateway")
    val activeAgentId = resolveActiveAgentId()
    val agents = homeCanvasAgents(activeAgentId)

    return when (state) {
      HomeCanvasGatewayState.Connected ->
        HomeCanvasPayload(
          gatewayState = "connected",
          eyebrow = nativeString("Connected to \$gatewayLabel", gatewayLabel),
          title = nativeString("Your agents are ready"),
          subtitle =
            nativeString("This phone stays dormant until the gateway needs it, then wakes, syncs, and goes back to sleep."),
          gatewayLabel = gatewayLabel,
          activeAgentName = resolveActiveAgentName(activeAgentId),
          activeAgentBadge = agents.firstOrNull { it.isActive }?.badge ?: "OC",
          activeAgentCaption = nativeString("Selected on this phone"),
          agentCount = agents.size,
          agents = agents.take(6),
          footer = nativeString("The overview refreshes on reconnect and when this screen opens."),
        )
      HomeCanvasGatewayState.Connecting ->
        HomeCanvasPayload(
          gatewayState = "connecting",
          eyebrow = nativeString("Reconnecting"),
          title = nativeString("OpenClaw is syncing back up"),
          subtitle =
            nativeString("The gateway session is coming back online. Agent shortcuts should settle automatically in a moment."),
          gatewayLabel = gatewayLabel,
          activeAgentName = resolveActiveAgentName(activeAgentId),
          activeAgentBadge = "OC",
          activeAgentCaption = nativeString("Gateway session in progress"),
          agentCount = agents.size,
          agents = agents.take(4),
          footer = nativeString("If the gateway is reachable, reconnect should complete without intervention."),
        )
      HomeCanvasGatewayState.Error, HomeCanvasGatewayState.Offline ->
        HomeCanvasPayload(
          gatewayState = if (state == HomeCanvasGatewayState.Error) "error" else "offline",
          eyebrow = nativeString("Welcome to OpenClaw"),
          title = nativeString("Your phone stays quiet until it is needed"),
          subtitle =
            nativeString("Pair this device to your gateway to wake it only for real work, keep a live agent overview handy, and avoid battery-draining background loops."),
          gatewayLabel = gatewayLabel,
          activeAgentName = nativeString("Main"),
          activeAgentBadge = "OC",
          activeAgentCaption = nativeString("Connect to load your agents"),
          agentCount = agents.size,
          agents = agents.take(4),
          footer = nativeString("When connected, the gateway can wake the phone with a silent push instead of holding an always-on session."),
        )
    }
  }

  private fun resolveHomeCanvasGatewayState(): HomeCanvasGatewayState {
    val display = gatewayConnectionDisplay.value
    val lower = display.statusText.trim().lowercase()
    return when {
      display.isConnected -> HomeCanvasGatewayState.Connected
      lower.contains("connecting") || lower.contains("reconnecting") -> HomeCanvasGatewayState.Connecting
      lower.contains("error") || lower.contains("failed") -> HomeCanvasGatewayState.Error
      else -> HomeCanvasGatewayState.Offline
    }
  }

  private fun resolveActiveAgentId(): String {
    val mainKey = _mainSessionKey.value.trim()
    if (mainKey.startsWith("agent:")) {
      val agentId = mainKey.removePrefix("agent:").substringBefore(':').trim()
      if (agentId.isNotEmpty()) return agentId
    }
    return gatewayDefaultAgentId.value?.trim().orEmpty()
  }

  private fun resolveActiveAgentName(activeAgentId: String): String {
    if (activeAgentId.isNotEmpty()) {
      gatewayAgents.value.firstOrNull { it.id == activeAgentId }?.let { agent ->
        return normalized(agent.name) ?: agent.id
      }
      return activeAgentId
    }
    return gatewayAgents.value.firstOrNull()?.let { normalized(it.name) ?: it.id } ?: nativeString("Main")
  }

  private fun homeCanvasAgents(activeAgentId: String): List<HomeCanvasAgentCard> {
    val defaultAgentId = gatewayDefaultAgentId.value?.trim().orEmpty()
    return gatewayAgents.value
      .map { agent ->
        val isActive = activeAgentId.isNotEmpty() && agent.id == activeAgentId
        val isDefault = defaultAgentId.isNotEmpty() && agent.id == defaultAgentId
        HomeCanvasAgentCard(
          id = agent.id,
          name = normalized(agent.name) ?: agent.id,
          badge = homeCanvasBadge(agent),
          caption =
            when {
              isActive -> nativeString("Active on this phone")
              isDefault -> nativeString("Default agent")
              else -> nativeString("Ready")
            },
          isActive = isActive,
        )
      }.sortedWith(compareByDescending<HomeCanvasAgentCard> { it.isActive }.thenBy { it.name.lowercase() })
  }

  private fun homeCanvasBadge(agent: GatewayAgentSummary): String {
    val emoji = normalized(agent.emoji)
    if (emoji != null) return emoji
    val initials =
      (normalized(agent.name) ?: agent.id)
        .split(' ', '-', '_')
        .filter { it.isNotBlank() }
        .take(2)
        .mapNotNull { token -> token.uppercaseFirstGraphemeOrNull() }
        .joinToString("")
    return if (initials.isNotEmpty()) initials else "OC"
  }

  private fun normalized(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    return trimmed.ifEmpty { null }
  }

  private fun showCameraHud(
    message: String,
    kind: CameraHudKind,
    autoHideMs: Long? = null,
  ) {
    val token = cameraHudSeq.incrementAndGet()
    _cameraHud.value = CameraHudState(token = token, kind = kind, message = message)

    if (autoHideMs != null && autoHideMs > 0) {
      scope.launch {
        delay(autoHideMs)
        if (_cameraHud.value?.token == token) _cameraHud.value = null
      }
    }
  }
}

internal fun resolveOperatorSessionConnectAuth(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): NodeRuntime.GatewayConnectAuth? {
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = explicitToken,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitPassword != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = explicitPassword,
    )
  }

  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitBootstrapToken = auth.bootstrapToken?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitBootstrapToken != null) {
    return null
  }

  return NodeRuntime.GatewayConnectAuth(
    token = null,
    bootstrapToken = null,
    password = null,
  )
}

internal fun resolveGatewayControlPageAuth(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): NodeRuntime.GatewayConnectAuth {
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = explicitToken,
      bootstrapToken = null,
      password = null,
    )
  }

  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  if (explicitPassword != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = null,
      bootstrapToken = null,
      password = explicitPassword,
    )
  }

  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken != null) {
    return NodeRuntime.GatewayConnectAuth(
      token = storedToken,
      bootstrapToken = null,
      password = null,
    )
  }

  return NodeRuntime.GatewayConnectAuth(
    token = null,
    bootstrapToken = null,
    password = null,
  )
}

internal fun operatorSessionUsesStoredDeviceToken(
  auth: NodeRuntime.GatewayConnectAuth,
  storedOperatorToken: String?,
): Boolean {
  val storedToken = storedOperatorToken?.trim()?.takeIf { it.isNotEmpty() }
  if (storedToken == null) return false
  val explicitToken = auth.token?.trim()?.takeIf { it.isNotEmpty() }
  val explicitPassword = auth.password?.trim()?.takeIf { it.isNotEmpty() }
  return explicitToken == null && explicitPassword == null
}

internal fun operatorConnectScopesForAuth(
  usesStoredDeviceToken: Boolean,
  storedOperatorScopes: List<String>?,
): List<String> {
  if (usesStoredDeviceToken && storedOperatorScopes != null) {
    return ConnectionManager.operatorScopesForStoredDeviceToken(storedOperatorScopes)
  }
  return ConnectionManager.nativeClientOperatorScopes
}

internal fun normalizeOperatorScopes(scopes: List<String>): List<String> =
  scopes
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .distinct()
    .sorted()

internal fun backgroundGatewayStableIds(
  entries: List<GatewayRegistryEntry>,
  connectedIds: List<String>,
  activeId: String?,
  foreground: Boolean,
): List<String> {
  if (!foreground) return emptyList()
  val registered = entries.mapTo(mutableSetOf()) { it.stableId }
  return connectedIds.distinct().filter { it != activeId && it in registered }
}

private enum class HomeCanvasGatewayState {
  Connected,
  Connecting,
  Error,
  Offline,
}

data class GatewayModelSummary(
  val id: String,
  val name: String,
  val provider: String,
  val available: Boolean?,
  val supportsVision: Boolean,
  val supportsAudio: Boolean,
  val supportsVideo: Boolean,
  val supportsDocuments: Boolean,
  val supportsReasoning: Boolean,
  val contextTokens: Long?,
)

internal fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
  models
    ?.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val id = obj["id"].asStringOrNull()?.trim().orEmpty()
      if (id.isEmpty()) return@mapNotNull null
      val provider = obj["provider"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id.substringBefore('/', "default")
      val inputTypes = (obj["input"] as? JsonArray)?.mapNotNull { it.asStringOrNull()?.trim()?.lowercase() }?.toSet().orEmpty()
      GatewayModelSummary(
        id = id,
        name = obj["name"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id,
        provider = provider,
        available = obj.optionalBoolean("available"),
        supportsVision = "image" in inputTypes,
        supportsAudio = "audio" in inputTypes,
        supportsVideo = "video" in inputTypes,
        supportsDocuments = "document" in inputTypes,
        supportsReasoning = obj["reasoning"].toString().trim() == "true",
        contextTokens = obj["contextTokens"].toString().toLongOrNull() ?: obj["contextWindow"].toString().toLongOrNull(),
      )
    }.orEmpty()

internal class ProviderModelConfigUnsupported : Exception()

internal suspend fun requestProviderModelConfig(request: suspend (String) -> String): String =
  try {
    request("""{"view":"provider-config"}""")
  } catch (err: GatewayRequestRejected) {
    if (err.gatewayError.code != "INVALID_REQUEST") throw err
    throw ProviderModelConfigUnsupported()
  }

data class GatewayModelProviderSummary(
  val id: String,
  val displayName: String,
  val status: String,
  val profileCount: Int,
)

data class GatewayCronStatus(
  val enabled: Boolean,
  val jobs: Int,
  val nextWakeAtMs: Long?,
)

data class GatewayCronJobSummary(
  val id: String,
  val name: String,
  val enabled: Boolean,
  val scheduleLabel: NativeText,
  val promptPreview: NativeText,
  val nextRunAtMs: Long?,
  val lastRunStatus: String?,
)

data class GatewayUsageSummary(
  val updatedAtMs: Long?,
  val providers: List<GatewayUsageProviderSummary>,
)

data class GatewayUsageProviderSummary(
  val displayName: String,
  val plan: String?,
  val error: String?,
  val windows: List<GatewayUsageWindowSummary>,
)

data class GatewayUsageWindowSummary(
  val label: String,
  val usedPercent: Double,
  val resetAtMs: Long?,
)

data class GatewaySkillsSummary(
  val managedSkillsDirAvailable: Boolean = false,
  val skills: List<GatewaySkillSummary>,
)

data class GatewaySkillWorkshopSummary(
  val agentId: String = "",
  val proposals: List<GatewaySkillWorkshopProposal>,
) {
  fun withProposal(proposal: GatewaySkillWorkshopProposal): GatewaySkillWorkshopSummary =
    copy(
      proposals =
        (proposals.filterNot { it.id == proposal.id } + proposal)
          .sortedByDescending { it.updatedAt },
    )
}

data class GatewaySkillWorkshopProposal(
  val id: String,
  val kind: String,
  val status: String,
  val title: String,
  val description: String?,
  val skillName: String,
  val skillKey: String,
  val createdAt: String,
  val updatedAt: String,
  val scanState: String?,
  val content: String? = null,
  val supportFiles: List<GatewaySkillWorkshopSupportFile> = emptyList(),
)

data class GatewaySkillWorkshopSupportFile(
  val path: String,
  val content: String?,
)

data class GatewaySkillSummary(
  val skillKey: String,
  val name: String,
  val description: String?,
  val source: String,
  val emoji: String?,
  val disabled: Boolean,
  val eligible: Boolean,
  val blockedByAllowlist: Boolean,
  val blockedByAgentFilter: Boolean,
  val bundled: Boolean,
  val missingCount: Int,
  val installCount: Int,
  val clawHubSlug: String? = null,
  val clawHubValid: Boolean = false,
  val clawHubOwnerHandle: String? = null,
  val clawHubInstalledVersion: String? = null,
)

data class GatewayNodesDevicesSummary(
  val nodes: List<GatewayNodeSummary>,
  val pendingDevices: List<GatewayPendingDeviceSummary>,
  val pairedDevices: List<GatewayPairedDeviceSummary>,
  val devicePairingAvailable: Boolean = true,
)

enum class GatewayNodeApprovalState {
  Loading,
  Unsupported,
  Approved,
  PendingApproval,
  PendingReapproval,
  Unapproved,
}

/** Current phone approval state; only pending variants can carry an approval target. */
sealed interface GatewayNodeCapabilityApproval {
  data object Loading : GatewayNodeCapabilityApproval

  data object Unsupported : GatewayNodeCapabilityApproval

  data object Approved : GatewayNodeCapabilityApproval

  data class PendingApproval(
    val requestId: String?,
  ) : GatewayNodeCapabilityApproval

  data class PendingReapproval(
    val requestId: String?,
  ) : GatewayNodeCapabilityApproval

  data object Unapproved : GatewayNodeCapabilityApproval
}

internal fun GatewayNodeCapabilityApproval.withoutExactRequestId(): GatewayNodeCapabilityApproval? =
  when (this) {
    is GatewayNodeCapabilityApproval.PendingApproval ->
      requestId?.let { GatewayNodeCapabilityApproval.PendingApproval(requestId = null) }
    is GatewayNodeCapabilityApproval.PendingReapproval ->
      requestId?.let { GatewayNodeCapabilityApproval.PendingReapproval(requestId = null) }
    else -> null
  }

internal fun GatewayNodesDevicesSummary.withoutExactApprovalRequestIds(): GatewayNodesDevicesSummary = copy(nodes = nodes.map { node -> node.copy(pendingRequestId = null) })

/** Prevents an older gateway response from publishing after a newer refresh begins. */
internal class LatestGatewayRefreshGuard {
  private val lock = Any()
  private var generation = 0L

  fun begin(): Long =
    synchronized(lock) {
      generation += 1
      generation
    }

  fun invalidate() {
    begin()
  }

  fun publishIfCurrent(
    refreshGeneration: Long,
    publish: () -> Unit,
  ): Boolean =
    synchronized(lock) {
      if (refreshGeneration != generation) return@synchronized false
      publish()
      true
    }
}

internal fun parseGatewayNodeApprovalState(raw: String?): GatewayNodeApprovalState =
  when (raw?.trim()?.lowercase()) {
    null, "" -> GatewayNodeApprovalState.Loading
    "approved" -> GatewayNodeApprovalState.Approved
    "pending-approval" -> GatewayNodeApprovalState.PendingApproval
    "pending-reapproval" -> GatewayNodeApprovalState.PendingReapproval
    "unapproved" -> GatewayNodeApprovalState.Unapproved
    else -> GatewayNodeApprovalState.Loading
  }

internal fun nodeConnectFailureNeedsApprovalRefresh(error: GatewaySession.ErrorShape): Boolean = error.details?.code == "PAIRING_REQUIRED"

internal fun currentNodeCapabilityApproval(
  nodes: List<GatewayNodeSummary>,
  selfNodeId: String,
): GatewayNodeCapabilityApproval {
  val node = nodes.firstOrNull { it.id == selfNodeId } ?: return GatewayNodeCapabilityApproval.Loading
  return when (node.approvalState) {
    GatewayNodeApprovalState.Loading -> GatewayNodeCapabilityApproval.Loading
    GatewayNodeApprovalState.Unsupported -> GatewayNodeCapabilityApproval.Unsupported
    GatewayNodeApprovalState.Approved -> GatewayNodeCapabilityApproval.Approved
    GatewayNodeApprovalState.PendingApproval ->
      GatewayNodeCapabilityApproval.PendingApproval(
        normalizeGatewayApprovalRequestId(node.pendingRequestId),
      )
    GatewayNodeApprovalState.PendingReapproval ->
      GatewayNodeCapabilityApproval.PendingReapproval(
        normalizeGatewayApprovalRequestId(node.pendingRequestId),
      )
    GatewayNodeApprovalState.Unapproved -> GatewayNodeCapabilityApproval.Unapproved
  }
}

internal fun parseGatewayNodeSummary(item: JsonElement): GatewayNodeSummary? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj["nodeId"].asStringOrNull()?.trim().orEmpty()
  if (id.isEmpty()) return null
  return GatewayNodeSummary(
    id = id,
    displayName = obj["displayName"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    remoteIp = obj["remoteIp"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    version = obj["version"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    deviceFamily = obj["deviceFamily"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    paired = obj.boolean("paired"),
    connected = obj.boolean("connected"),
    // Only an omitted field identifies a legacy gateway; malformed and future values stay fail-closed.
    approvalState =
      if (obj.containsKey("approvalState")) {
        parseGatewayNodeApprovalState(obj["approvalState"].asStringOrNull())
      } else {
        GatewayNodeApprovalState.Unsupported
      },
    pendingRequestId = normalizeGatewayApprovalRequestId(obj["pendingRequestId"].asStringOrNull()),
    capabilities = parseGatewayStringArray(obj["caps"] as? JsonArray),
    commands = parseGatewayStringArray(obj["commands"] as? JsonArray),
  )
}

internal fun parseGatewayNodeList(root: JsonObject?): List<GatewayNodeSummary> {
  if (root == null) return emptyList()
  val seen = mutableSetOf<String>()
  val result = mutableListOf<GatewayNodeSummary>()

  fun append(nodes: JsonArray?) {
    for (node in nodes?.mapNotNull(::parseGatewayNodeSummary).orEmpty()) {
      if (seen.add(node.id)) {
        result.add(node)
      }
    }
  }

  append(root["nodes"] as? JsonArray)
  append(root["pending"] as? JsonArray)
  append(root["paired"] as? JsonArray)
  return result
}

data class GatewayNodeSummary(
  val id: String,
  val displayName: String?,
  val remoteIp: String?,
  val version: String?,
  val deviceFamily: String?,
  val paired: Boolean,
  val connected: Boolean,
  val approvalState: GatewayNodeApprovalState,
  val pendingRequestId: String?,
  val capabilities: List<String>,
  val commands: List<String>,
)

data class GatewayPendingDeviceSummary(
  val requestId: String,
  val deviceId: String,
  val publicKey: String? = null,
  val displayName: String?,
  val platform: String? = null,
  val deviceFamily: String? = null,
  val clientId: String? = null,
  val clientMode: String? = null,
  val browserOrigin: String? = null,
  val remoteIp: String?,
  val roles: List<String>,
  val scopes: List<String>,
  val requestedAtMs: Long?,
  val repair: Boolean,
)

data class GatewayPairedDeviceSummary(
  val deviceId: String,
  val displayName: String?,
  val remoteIp: String?,
  val roles: List<String>,
  val scopes: List<String>,
  val tokens: List<GatewayDeviceTokenSummary>,
  val approvedAtMs: Long?,
)

data class GatewayDeviceTokenSummary(
  val role: String,
  val scopes: List<String>,
  val revoked: Boolean,
  val updatedAtMs: Long?,
)

data class GatewayChannelsSummary(
  val updatedAtMs: Long? = null,
  val partial: Boolean = false,
  val warnings: List<String> = emptyList(),
  val channels: List<GatewayChannelSummary>,
)

data class GatewayChannelSummary(
  val id: String,
  val label: String,
  val accountCount: Int,
  val enabled: Boolean,
  val configured: Boolean,
  val linked: Boolean,
  val running: Boolean,
  val connected: Boolean,
  val error: String?,
)

private data class GatewayChannelAccountSummary(
  val enabled: Boolean,
  val configured: Boolean,
  val linked: Boolean,
  val running: Boolean,
  val connected: Boolean,
  val error: String?,
)

data class GatewayDreamingSummary(
  val enabled: Boolean = false,
  val timezone: String? = null,
  val shortTermCount: Int = 0,
  val groundedSignalCount: Int = 0,
  val totalSignalCount: Int = 0,
  val promotedToday: Int = 0,
  val promotedTotal: Int = 0,
  val nextRunAtMs: Long? = null,
  val storeHealthy: Boolean = true,
  val phaseSignalHealthy: Boolean = true,
  val diaryFound: Boolean = false,
  val diaryEntries: List<GatewayDreamDiaryEntry> = emptyList(),
  val diaryEntryCount: Int = 0,
)

data class GatewayDreamDiaryEntry(
  val date: NativeText,
  val text: String,
)

internal fun parseGatewayDreamDiaryEntry(block: String): GatewayDreamDiaryEntry? {
  val lines = block.trim().lines()
  val date =
    lines
      .firstOrNull { line ->
        val trimmed = line.trim()
        trimmed.length > 2 && trimmed.startsWith("*") && trimmed.endsWith("*")
      }?.trim()
      ?.trim('*')
      ?.takeIf { it.isNotEmpty() }
  val text =
    lines
      .map { it.trim() }
      .filter { line -> line.isNotEmpty() && !line.startsWith("#") && !line.startsWith("<!--") && !(line.startsWith("*") && line.endsWith("*")) }
      .joinToString(" ")
      .replace(Regex("\\s+"), " ")
      .takeIf { it.isNotEmpty() }
  return text?.let {
    GatewayDreamDiaryEntry(
      date = date?.let(::verbatimText) ?: nativeText("Dream"),
      text = it,
    )
  }
}

data class GatewayHealthLogsSummary(
  val fileName: String? = null,
  val cursor: Long? = null,
  val truncated: Boolean = false,
  val entries: List<GatewayLogEntry> = emptyList(),
)

data class GatewayLogEntry(
  val time: String?,
  val level: String?,
  val subsystem: String?,
  val message: String,
  val raw: String,
)

private val gatewayAnsiControlPattern = Regex("\\u001B\\[[0-?]*[ -/]*[@-~]")
private val gatewayEscapedAnsiControlPattern = Regex("""\\u001[Bb]\[[0-?]*[ -/]*[@-~]""")
private val gatewayVisibleSgrPattern = Regex("\\[(?:0|\\d{1,3}(?:;\\d{1,3})*)m(?!])")

internal fun sanitizeGatewayLogText(value: String): String =
  value
    .replace(gatewayAnsiControlPattern, "")
    .replace(gatewayEscapedAnsiControlPattern, "")
    .replace(gatewayVisibleSgrPattern, "")

private fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()

private fun JsonObject?.double(key: String): Double? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toDoubleOrNull()

private fun JsonObject?.boolean(key: String): Boolean = (this?.get(key) as? JsonPrimitive)?.content?.trim() == "true"

private fun JsonObject?.optionalBoolean(key: String): Boolean? =
  (this?.get(key) as? JsonPrimitive)?.content?.trim()?.lowercase()?.let { value ->
    when (value) {
      "true" -> true
      "false" -> false
      else -> null
    }
  }

internal fun cronJobLastRunStatus(state: JsonObject?): String? =
  state
    .cronStatus("lastStatus")
    ?: state.cronStatus("lastRunStatus")

private fun JsonObject?.cronStatus(key: String): String? =
  this
    ?.get(key)
    .asStringOrNull()
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

private fun parseGatewayStringArray(items: JsonArray?): List<String> =
  items
    ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf { value -> value.isNotEmpty() } }
    .orEmpty()

fun providerDisplayName(provider: String): String =
  when (provider.trim().lowercase()) {
    "openai" -> "OpenAI"
    "openrouter" -> "OpenRouter"
    "codex" -> "Codex"
    "ollama", "ollama-local" -> "Ollama Local"
    else ->
      provider
        .replace('-', ' ')
        .replace('_', ' ')
        .split(' ')
        .filter { it.isNotBlank() }
        .joinToString(" ") { token -> token.replaceFirstChar { it.uppercase() } }
        .replace(" Ai", " AI")
        .ifBlank { "Provider" }
  }

fun channelDisplayLabel(channel: String): String =
  when (channel.trim().lowercase()) {
    "imessage" -> "iMessage"
    "googlechat" -> "Google Chat"
    "whatsapp" -> "WhatsApp"
    else ->
      channel
        .replace('-', ' ')
        .replace('_', ' ')
        .split(' ')
        .filter { it.isNotBlank() }
        .joinToString(" ") { token -> token.replaceFirstChar { it.uppercase() } }
        .ifBlank { "Channel" }
  }

@Serializable
private data class HomeCanvasPayload(
  val gatewayState: String,
  val eyebrow: String,
  val title: String,
  val subtitle: String,
  val gatewayLabel: String,
  val activeAgentName: String,
  val activeAgentBadge: String,
  val activeAgentCaption: String,
  val agentCount: Int,
  val agents: List<HomeCanvasAgentCard>,
  val footer: String,
)

@Serializable
private data class HomeCanvasAgentCard(
  val id: String,
  val name: String,
  val badge: String,
  val caption: String,
  val isActive: Boolean,
)
