package ai.openclaw.app

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.net.toUri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest
import java.util.UUID

internal const val actionOpenConversationNotification =
  "ai.openclaw.app.action.OPEN_CONVERSATION_NOTIFICATION"
internal const val actionConsumeConversationNotification =
  "ai.openclaw.app.action.CONSUME_CONVERSATION_NOTIFICATION"
internal const val actionReplyConversationNotification =
  "ai.openclaw.app.action.REPLY_CONVERSATION_NOTIFICATION"

private const val extraGatewayStableId = "ai.openclaw.app.extra.CONVERSATION_GATEWAY_ID"
private const val extraAgentId = "ai.openclaw.app.extra.CONVERSATION_AGENT_ID"
private const val extraSessionKey = "ai.openclaw.app.extra.CONVERSATION_SESSION_KEY"
private const val extraRunId = "ai.openclaw.app.extra.CONVERSATION_RUN_ID"
private const val extraLaunchToken = "ai.openclaw.app.extra.CONVERSATION_LAUNCH_TOKEN"
private const val extraPublicationGeneration = "ai.openclaw.app.extra.CONVERSATION_PUBLICATION_GENERATION"
private const val remoteInputReply = "ai.openclaw.app.remote_input.CONVERSATION_REPLY"
private const val notificationIntentScheme = "openclaw"
private const val notificationIntentAuthority = "conversation-notification"
private const val notificationIntentOpenPath = "open"
private const val notificationIntentReplyPath = "reply-v2"
private const val legacyNotificationIntentReplyPath = "reply"
private const val conversationChannelId = "openclaw.chat.replies"
private const val conversationNotificationId = 1
private const val conversationNotificationTagPrefix = "openclaw.chat."
private const val conversationShortcutPrefix = "openclaw-chat-"
private const val conversationGroup = "openclaw.chat"
private const val replyTimeoutMs = 5_000L
private const val replyRecoveryTimeoutMs = 1_000L
private const val maxTargetPartLength = 2_048
private const val maxReplyLength = 16_000
private const val maxPendingConversationLaunches = 32
private const val conversationLaunchRequestCode = 0
private const val conversationReplyRequestCode = 1
private const val conversationGenerationRequestCode = 2

internal data class ConversationNotificationTarget(
  val gatewayStableId: String,
  val agentId: String,
  val sessionKey: String,
  val runId: String,
) {
  val conversationDigest: String
    get() = stableDigest(gatewayStableId, agentId, sessionKey)

  val intentIdentityDigest: String
    get() = fullStableDigest(gatewayStableId, agentId, sessionKey, runId)

  val shortcutId: String
    get() = conversationShortcutPrefix + conversationDigest

  val notificationTag: String
    get() = conversationNotificationTagPrefix + conversationDigest

  fun toComposerOwner(): ChatComposerOwner =
    ChatComposerOwner(
      gatewayStableId = gatewayStableId,
      agentId = agentId,
      sessionKey = sessionKey,
      routingVerified = true,
    )

  companion object {
    fun from(
      owner: ChatComposerOwner,
      runId: String,
    ): ConversationNotificationTarget? {
      if (!owner.routingVerified) return null
      val gatewayStableId = owner.gatewayStableId.validTargetPart() ?: return null
      val agentId = owner.agentId.validTargetPart() ?: return null
      val sessionKey = owner.sessionKey.validTargetPart() ?: return null
      val normalizedRunId = runId.validTargetPart() ?: return null
      return ConversationNotificationTarget(
        gatewayStableId = gatewayStableId,
        agentId = agentId,
        sessionKey = sessionKey,
        runId = normalizedRunId,
      )
    }
  }
}

internal fun conversationNotificationLaunchIntent(
  context: Context,
  target: ConversationNotificationTarget,
): Intent =
  Intent()
    .setClass(context, ConversationNotificationLaunchActivity::class.java)
    .setAction(actionOpenConversationNotification)
    .setData(conversationNotificationIntentData(notificationIntentOpenPath, target))
    .putConversationTarget(target)

internal fun parseConversationNotificationTrampolineIntent(intent: Intent?): ConversationNotificationTarget? =
  intent.readOwnedConversationTarget(
    expectedAction = actionOpenConversationNotification,
    identityPath = notificationIntentOpenPath,
  )

internal fun conversationNotificationMainIntent(
  context: Context,
  launchToken: String,
): Intent =
  Intent(context, MainActivity::class.java)
    .setAction(actionConsumeConversationNotification)
    .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    .putExtra(extraLaunchToken, launchToken)

internal fun parseConversationNotificationLaunchIntent(
  intent: Intent?,
  takeTarget: (String) -> ConversationNotificationTarget?,
): ConversationNotificationTarget? {
  if (intent?.action != actionConsumeConversationNotification) return null
  val launchToken = intent.getStringExtra(extraLaunchToken).validLaunchToken() ?: return null
  return takeTarget(launchToken)
}

internal fun conversationNotificationReplyIntent(
  context: Context,
  target: ConversationNotificationTarget,
): Intent =
  Intent()
    .setClass(context, ConversationReplyReceiver::class.java)
    .setAction(actionReplyConversationNotification)
    .setData(conversationNotificationIntentData(notificationIntentReplyPath, target))
    .putConversationTarget(target)

internal data class ConversationNotificationReply(
  val target: ConversationNotificationTarget,
  val generation: PendingIntent?,
)

internal fun parseConversationNotificationReplyIntent(intent: Intent?): ConversationNotificationReply? {
  if (intent?.action != actionReplyConversationNotification) return null
  val target = intent.readConversationTarget() ?: return null
  val generation =
    when (intent.data) {
      conversationNotificationIntentData(notificationIntentReplyPath, target) -> {
        IntentCompat.getParcelableExtra(intent, extraPublicationGeneration, PendingIntent::class.java)
      }

      // v2026.9.1's mutable Reply envelope cannot authenticate a generation added by its sender.
      conversationNotificationIntentData(legacyNotificationIntentReplyPath, target) -> {
        null
      }

      else -> {
        return null
      }
    }
  return ConversationNotificationReply(target, generation)
}

internal fun conversationNotificationReplyIdempotencyKey(target: ConversationNotificationTarget): String =
  "android-notification-reply-" +
    stableDigest(
      target.gatewayStableId,
      target.agentId,
      target.sessionKey,
      target.runId,
    )

private fun Intent.putConversationTarget(target: ConversationNotificationTarget): Intent =
  putExtra(extraGatewayStableId, target.gatewayStableId)
    .putExtra(extraAgentId, target.agentId)
    .putExtra(extraSessionKey, target.sessionKey)
    .putExtra(extraRunId, target.runId)

private fun Intent.readConversationTarget(): ConversationNotificationTarget? {
  val gatewayStableId = getStringExtra(extraGatewayStableId).validTargetPart() ?: return null
  val agentId = getStringExtra(extraAgentId).validTargetPart() ?: return null
  val sessionKey = getStringExtra(extraSessionKey).validTargetPart() ?: return null
  val runId = getStringExtra(extraRunId).validTargetPart() ?: return null
  return ConversationNotificationTarget(
    gatewayStableId = gatewayStableId,
    agentId = agentId,
    sessionKey = sessionKey,
    runId = runId,
  )
}

private fun Intent?.readOwnedConversationTarget(
  expectedAction: String,
  identityPath: String,
): ConversationNotificationTarget? {
  if (this?.action != expectedAction) return null
  val target = readConversationTarget() ?: return null
  return target.takeIf { data == conversationNotificationIntentData(identityPath, target) }
}

private fun conversationNotificationIntentData(
  identityPath: String,
  target: ConversationNotificationTarget,
): Uri =
  Uri
    .Builder()
    .scheme(notificationIntentScheme)
    .authority(notificationIntentAuthority)
    .appendPath(identityPath)
    .appendPath(target.intentIdentityDigest)
    .build()

private fun String?.validTargetPart(): String? =
  this
    ?.trim()
    ?.takeIf { value -> value.isNotEmpty() && value.length <= maxTargetPartLength }

private fun String?.validLaunchToken(): String? {
  val value = this ?: return null
  return runCatching { UUID.fromString(value).toString() }
    .getOrNull()
    ?.takeIf { normalized -> normalized == value }
}

private fun fullStableDigest(vararg parts: String): String {
  val digest = MessageDigest.getInstance("SHA-256")
  parts.forEach { part ->
    digest.update(part.toByteArray(Charsets.UTF_8))
    digest.update(0)
  }
  return digest.digest().joinToString(separator = "") { byte -> "%02x".format(byte) }
}

private fun stableDigest(vararg parts: String): String = fullStableDigest(*parts).take(24)

internal class ConversationNotificationLaunchStore(
  private val capacity: Int = maxPendingConversationLaunches,
) {
  private val targets = LinkedHashMap<String, ConversationNotificationTarget>()

  init {
    require(capacity > 0)
  }

  @Synchronized
  fun put(target: ConversationNotificationTarget): String {
    var token: String
    do {
      token = UUID.randomUUID().toString()
    } while (targets.containsKey(token))
    while (targets.size >= capacity) {
      val iterator = targets.entries.iterator()
      iterator.next()
      iterator.remove()
    }
    targets[token] = target
    return token
  }

  @Synchronized
  fun take(token: String): ConversationNotificationTarget? = targets.remove(token)
}

// This non-exported activity is a notification security boundary, not a launch screen.
// It replaces private target extras with a process-local one-shot token before opening MainActivity.
@SuppressLint("CustomSplashScreen")
class ConversationNotificationLaunchActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState != null) {
      finish()
      return
    }
    val target = parseConversationNotificationTrampolineIntent(intent)
    val app = application as? NodeApp
    if (target == null || app == null) {
      finish()
      return
    }
    val launchToken = app.conversationNotificationLaunchStore.put(target)
    startActivity(conversationNotificationMainIntent(this, launchToken))
    finish()
  }
}

internal fun canPostConversationNotifications(
  sdkInt: Int,
  permissionGranted: () -> Boolean,
): Boolean = sdkInt < Build.VERSION_CODES.TIRAMISU || permissionGranted()

internal suspend fun routeConversationNotificationTarget(
  target: ConversationNotificationTarget,
  switchGateway: suspend (String) -> GatewayTargetSelection,
  awaitGatewayReady: suspend (String) -> Boolean = { true },
  isCurrent: () -> Boolean,
  switchSession: (sessionKey: String, agentId: String) -> Unit,
): GatewayTargetSelection {
  if (!isCurrent()) return GatewayTargetSelection.Retired
  val selection = switchGateway(target.gatewayStableId)
  if (!isCurrent()) return GatewayTargetSelection.Retired
  if (selection !is GatewayTargetSelection.Selected) return selection
  if (!selection.isCurrent()) return GatewayTargetSelection.Retired
  val ready = awaitGatewayReady(target.gatewayStableId)
  if (!isCurrent() || !selection.isCurrent()) return GatewayTargetSelection.Retired
  if (!ready) return GatewayTargetSelection.Unavailable
  switchSession(target.sessionKey, target.agentId)
  return selection
}

internal suspend fun routeConversationNotificationReply(
  target: ConversationNotificationTarget,
  reply: String,
  idempotencyKey: String,
  switchGateway: suspend (String) -> GatewayTargetSelection,
  awaitGatewayReady: suspend (String) -> Boolean,
  isCurrent: () -> Boolean,
  switchSession: (sessionKey: String, agentId: String) -> Unit,
  send: suspend (owner: ChatComposerOwner, message: String, idempotencyKey: String, canAdmit: () -> Boolean) -> Boolean,
): Boolean {
  val selection =
    routeConversationNotificationTarget(
      target = target,
      switchGateway = switchGateway,
      awaitGatewayReady = awaitGatewayReady,
      isCurrent = isCurrent,
      switchSession = switchSession,
    )
  return selection is GatewayTargetSelection.Selected &&
    isCurrent() && selection.isCurrent() &&
    send(target.toComposerOwner(), reply, idempotencyKey) { isCurrent() && selection.isCurrent() }
}

internal enum class ConversationNotificationReplyOutcome {
  Admitted,
  NotAdmitted,
  Unknown,
}

internal suspend fun sendConversationNotificationReplyWithRecovery(
  timeoutMs: Long,
  send: suspend () -> Boolean,
  wasAdmitted: suspend () -> Boolean?,
): ConversationNotificationReplyOutcome {
  if (boundedConversationReplyStep(timeoutMs, send) == true) {
    return ConversationNotificationReplyOutcome.Admitted
  }
  return when (boundedConversationReplyStep(replyRecoveryTimeoutMs, wasAdmitted)) {
    true -> ConversationNotificationReplyOutcome.Admitted
    false -> ConversationNotificationReplyOutcome.NotAdmitted
    null -> ConversationNotificationReplyOutcome.Unknown
  }
}

// Only this step's timeout is an unknown result; caller cancellation still ends the Reply.
private suspend fun boundedConversationReplyStep(
  timeoutMs: Long,
  operation: suspend () -> Boolean?,
): Boolean? =
  try {
    withTimeoutOrNull(timeoutMs) { operation() }
  } catch (err: CancellationException) {
    throw err
  } catch (_: Throwable) {
    null
  }

internal class ConversationReplyNotifier(
  private val context: Context,
) {
  fun show(
    owner: ChatComposerOwner,
    runId: String,
    assistantText: String,
  ): Boolean =
    synchronized(publicationLock) {
      val target = ConversationNotificationTarget.from(owner, runId) ?: return@synchronized false
      val text = assistantText.trim().takeIf(String::isNotEmpty) ?: return@synchronized false
      if (!canPostNotifications()) return@synchronized false
      val generation = checkNotNull(publicationGeneration(target, PendingIntent.FLAG_CANCEL_CURRENT))
      try {
        post(target, buildAssistantReplyNotification(target, text, generation))
        true
      } catch (err: Throwable) {
        // Cancel only this token: cancelling an obsolete token can remove its replacement's lookup key.
        if (generation == publicationGeneration(target, PendingIntent.FLAG_NO_CREATE)) generation.cancel()
        throw err
      }
    }

  fun completeReply(
    notificationReply: ConversationNotificationReply,
    reply: String,
    outcome: ConversationNotificationReplyOutcome,
    isCurrent: () -> Boolean,
  ): Boolean =
    synchronized(publicationLock) {
      val target = notificationReply.target
      val generation = notificationReply.generation ?: return@synchronized false
      if (!isCurrent() || generation != publicationGeneration(target, PendingIntent.FLAG_NO_CREATE)) {
        return@synchronized false
      }
      if (!canPostNotifications()) return@synchronized false
      val contentIntent = contentPendingIntent(target)
      val text =
        when (outcome) {
          ConversationNotificationReplyOutcome.Admitted -> {
            nativeString("Reply queued")
          }

          ConversationNotificationReplyOutcome.NotAdmitted -> {
            nativeString("Chat failed")
          }

          ConversationNotificationReplyOutcome.Unknown -> {
            nativeString("Reply status is unknown. Open the conversation before sending again.")
          }
        }
      val action =
        if (outcome == ConversationNotificationReplyOutcome.NotAdmitted) {
          replyAction(target, generation)
        } else {
          NotificationCompat.Action.Builder(0, nativeString("Open conversation"), contentIntent).build()
        }
      // Reply outcomes update the notice; Android may retain and re-enqueue a canceled direct reply.
      post(
        target,
        baseBuilder(target, contentIntent, generation)
          .setSilent(outcome == ConversationNotificationReplyOutcome.Admitted)
          .setContentText(text)
          .setStyle(NotificationCompat.BigTextStyle().bigText("$text\n\n${reply.take(maxReplyLength)}"))
          .addAction(action)
          .build(),
      )
      true
    }

  private fun post(
    target: ConversationNotificationTarget,
    notification: Notification,
  ) {
    ensureChannel()
    ensureConversationShortcut(target)
    notificationManager().notify(target.notificationTag, conversationNotificationId, notification)
  }

  // An inert Android token owns publication identity, never permission to send a Reply.
  private fun publicationGeneration(
    target: ConversationNotificationTarget,
    flags: Int,
  ): PendingIntent? =
    PendingIntent.getBroadcast(
      context,
      conversationGenerationRequestCode,
      Intent()
        .setClass(context, ConversationReplyReceiver::class.java)
        .setAction("ai.openclaw.app.action.CONVERSATION_PUBLICATION_GENERATION")
        .setData("$notificationIntentScheme://$notificationIntentAuthority/generation/${target.conversationDigest}".toUri()),
      flags or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun buildAssistantReplyNotification(
    target: ConversationNotificationTarget,
    assistantText: String,
    generation: PendingIntent,
  ): Notification {
    val contentIntent = contentPendingIntent(target)
    val assistant = assistantPerson()
    val style =
      NotificationCompat
        .MessagingStyle(userPerson())
        .setConversationTitle(nativeString("OpenClaw"))
        .setGroupConversation(false)
        .addMessage(assistantText, System.currentTimeMillis(), assistant)
    return baseBuilder(target, contentIntent, generation)
      .setStyle(style)
      .setContentText(assistantText)
      .addPerson(assistant)
      .addAction(replyAction(target, generation))
      .build()
  }

  private fun baseBuilder(
    target: ConversationNotificationTarget,
    contentIntent: PendingIntent,
    generation: PendingIntent,
  ): NotificationCompat.Builder =
    NotificationCompat
      .Builder(context, conversationChannelId)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentTitle(nativeString("OpenClaw"))
      .setContentIntent(contentIntent)
      .setPublicVersion(publicVersion(contentIntent))
      .addExtras(Bundle().apply { putParcelable(extraPublicationGeneration, generation) })
      .setAutoCancel(true)
      .setOnlyAlertOnce(false)
      .setGroup(conversationGroup)
      .setShortcutId(target.shortcutId)
      .setLocusId(LocusIdCompat(target.shortcutId))
      .setAllowSystemGeneratedContextualActions(false)

  private fun publicVersion(contentIntent: PendingIntent): Notification =
    NotificationCompat
      .Builder(context, conversationChannelId)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(nativeString("OpenClaw"))
      .setContentText(nativeString("Chat"))
      .setContentIntent(contentIntent)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .build()

  private fun replyAction(
    target: ConversationNotificationTarget,
    generation: PendingIntent,
  ): NotificationCompat.Action {
    val intent = conversationNotificationReplyIntent(context, target).putExtra(extraPublicationGeneration, generation)
    val pendingIntent =
      PendingIntent.getBroadcast(
        context,
        conversationReplyRequestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_MUTABLE,
      )
    val remoteInput =
      RemoteInput
        .Builder(remoteInputReply)
        .setLabel(nativeString("Reply to OpenClaw…"))
        .build()
    return NotificationCompat.Action
      .Builder(0, nativeString("Reply"), pendingIntent)
      .addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(true)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .build()
  }

  private fun contentPendingIntent(target: ConversationNotificationTarget): PendingIntent =
    PendingIntent.getActivity(
      context,
      conversationLaunchRequestCode,
      conversationNotificationLaunchIntent(context, target),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun ensureConversationShortcut(target: ConversationNotificationTarget) {
    val shortcut =
      ShortcutInfoCompat
        .Builder(context, target.shortcutId)
        .setShortLabel(nativeString("OpenClaw"))
        .setLongLived(true)
        .setPerson(assistantPerson())
        .setLocusId(LocusIdCompat(target.shortcutId))
        .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
        .setIntent(conversationNotificationLaunchIntent(context, target))
        .build()
    runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }
  }

  private fun assistantPerson(): Person =
    Person
      .Builder()
      .setName(nativeString("OpenClaw"))
      .setBot(true)
      .build()

  private fun userPerson(): Person = Person.Builder().setName(nativeString("You")).build()

  private fun canPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true

    return canPostConversationNotifications(Build.VERSION.SDK_INT) {
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED
    }
  }

  private fun ensureChannel() {
    val channel =
      NotificationChannel(
        conversationChannelId,
        nativeString("Chat"),
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        setShowBadge(true)
      }
    notificationManager().createNotificationChannel(channel)
  }

  private fun notificationManager(): NotificationManager = context.getSystemService(NotificationManager::class.java)

  private companion object {
    // Android enqueues notifications asynchronously; rotate and check generations in the same owner as every effect.
    val publicationLock = Any()
  }
}

class ConversationReplyReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val notificationReply = parseConversationNotificationReplyIntent(intent) ?: return
    val target = notificationReply.target
    val reply =
      RemoteInput
        .getResultsFromIntent(intent)
        ?.getCharSequence(remoteInputReply)
        ?.toString()
        ?.trim()
        ?.takeIf { value -> value.isNotEmpty() && value.length <= maxReplyLength }
        ?: return
    val pendingResult = goAsync()
    val app = context.applicationContext as? NodeApp
    if (app == null) {
      pendingResult.finish()
      return
    }
    val isCurrent = NodeForegroundService.resume(context, startNow = false)
    runCatching { NodeForegroundService.start(context) }
    app.launchRuntimeTask {
      try {
        val idempotencyKey = conversationNotificationReplyIdempotencyKey(target)
        var runtime: NodeRuntime? = null
        val outcome =
          sendConversationNotificationReplyWithRecovery(
            timeoutMs = replyTimeoutMs,
            send = {
              if (!isCurrent()) {
                false
              } else {
                val resolvedRuntime = app.ensureBackgroundRuntime()
                runtime = resolvedRuntime
                resolvedRuntime.sendConversationNotificationReply(
                  target = target,
                  reply = reply,
                  idempotencyKey = idempotencyKey,
                  isCurrent = isCurrent,
                )
              }
            },
            wasAdmitted = {
              runtime?.wasChatOutboxCommandAdmitted(idempotencyKey)
            },
          )
        val notifier = ConversationReplyNotifier(context.applicationContext)
        runCatching {
          if (!notifier.completeReply(notificationReply, reply, outcome, isCurrent)) {
            Log.i("OpenClaw", "Inline Reply ${outcome.name}: notification update skipped")
          }
        }.onFailure {
          Log.w("OpenClaw", "Inline Reply notification update failed")
        }
      } finally {
        pendingResult.finish()
      }
    }
  }
}
