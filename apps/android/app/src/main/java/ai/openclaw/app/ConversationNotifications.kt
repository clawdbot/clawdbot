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
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
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
private const val remoteInputReply = "ai.openclaw.app.remote_input.CONVERSATION_REPLY"
private const val notificationIntentScheme = "openclaw"
private const val notificationIntentAuthority = "conversation-notification"
private const val notificationIntentOpenPath = "open"
private const val notificationIntentReplyPath = "reply"
private const val conversationChannelId = "openclaw.chat.replies"
private const val conversationNotificationId = 1
private const val conversationNotificationTagPrefix = "openclaw.chat."
private const val conversationShortcutPrefix = "openclaw-chat-"
private const val conversationGroup = "openclaw.chat"
private const val replyTimeoutMs = 5_000L
private const val maxTargetPartLength = 2_048
private const val maxReplyLength = 16_000
private const val maxPendingConversationLaunches = 32
private const val conversationLaunchRequestCode = 0
private const val conversationReplyRequestCode = 1

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

internal fun parseConversationNotificationReplyIntent(intent: Intent?): ConversationNotificationTarget? =
  intent.readOwnedConversationTarget(
    expectedAction = actionReplyConversationNotification,
    identityPath = notificationIntentReplyPath,
  )

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
  activeGatewayStableId: () -> String?,
  switchGateway: suspend (String) -> Boolean,
  awaitGatewayReady: suspend (String) -> Boolean = { true },
  switchSession: (sessionKey: String, agentId: String) -> Unit,
): Boolean {
  if (activeGatewayStableId() != target.gatewayStableId && !switchGateway(target.gatewayStableId)) {
    return false
  }
  if (!awaitGatewayReady(target.gatewayStableId)) {
    return false
  }
  switchSession(target.sessionKey, target.agentId)
  return true
}

internal suspend fun routeConversationNotificationReply(
  target: ConversationNotificationTarget,
  reply: String,
  idempotencyKey: String,
  activeGatewayStableId: () -> String?,
  switchGateway: suspend (String) -> Boolean,
  awaitGatewayReady: suspend (String) -> Boolean,
  switchSession: (sessionKey: String, agentId: String) -> Unit,
  send: suspend (owner: ChatComposerOwner, message: String, idempotencyKey: String) -> Boolean,
): Boolean {
  if (
    !routeConversationNotificationTarget(
      target = target,
      activeGatewayStableId = activeGatewayStableId,
      switchGateway = switchGateway,
      awaitGatewayReady = awaitGatewayReady,
      switchSession = switchSession,
    )
  ) {
    return false
  }
  return send(target.toComposerOwner(), reply, idempotencyKey)
}

internal suspend fun sendConversationNotificationReplyWithRecovery(
  timeoutMs: Long,
  send: suspend () -> Boolean,
  wasAdmitted: suspend () -> Boolean,
): Boolean {
  val sent =
    try {
      withTimeout(timeoutMs) { send() }
    } catch (_: TimeoutCancellationException) {
      false
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      false
    }
  if (sent) return true

  return try {
    wasAdmitted()
  } catch (err: CancellationException) {
    throw err
  } catch (_: Throwable) {
    false
  }
}

internal class ConversationReplyNotifier(
  private val context: Context,
) {
  fun show(
    owner: ChatComposerOwner,
    runId: String,
    assistantText: String,
  ): Boolean {
    val target = ConversationNotificationTarget.from(owner, runId) ?: return false
    val text = assistantText.trim().takeIf(String::isNotEmpty) ?: return false
    if (!canPostNotifications()) return false
    ensureChannel()
    ensureConversationShortcut(target)
    notificationManager().notify(
      target.notificationTag,
      conversationNotificationId,
      buildAssistantReplyNotification(target, text),
    )
    return true
  }

  fun showSendFailure(target: ConversationNotificationTarget) {
    if (!canPostNotifications()) return
    ensureChannel()
    ensureConversationShortcut(target)
    notificationManager().notify(
      target.notificationTag,
      conversationNotificationId,
      buildSendFailureNotification(target),
    )
  }

  fun cancel(target: ConversationNotificationTarget) {
    notificationManager().cancel(target.notificationTag, conversationNotificationId)
  }

  internal fun buildAssistantReplyNotification(
    target: ConversationNotificationTarget,
    assistantText: String,
  ): Notification {
    val contentIntent = contentPendingIntent(target)
    val assistant = assistantPerson()
    val style =
      NotificationCompat
        .MessagingStyle(userPerson())
        .setConversationTitle(nativeString("OpenClaw"))
        .setGroupConversation(false)
        .addMessage(assistantText, System.currentTimeMillis(), assistant)
    return baseBuilder(target, contentIntent)
      .setStyle(style)
      .setContentTitle(nativeString("OpenClaw"))
      .setContentText(assistantText)
      .addPerson(assistant)
      .addAction(replyAction(target))
      .setPublicVersion(publicVersion(contentIntent))
      .build()
  }

  internal fun buildSendFailureNotification(target: ConversationNotificationTarget): Notification {
    val contentIntent = contentPendingIntent(target)
    return baseBuilder(target, contentIntent)
      .setContentTitle(nativeString("OpenClaw"))
      .setContentText(nativeString("Chat failed"))
      .addAction(replyAction(target))
      .setPublicVersion(publicVersion(contentIntent))
      .build()
  }

  private fun baseBuilder(
    target: ConversationNotificationTarget,
    contentIntent: PendingIntent,
  ): NotificationCompat.Builder =
    NotificationCompat
      .Builder(context, conversationChannelId)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(contentIntent)
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

  private fun replyAction(target: ConversationNotificationTarget): NotificationCompat.Action {
    val intent = conversationNotificationReplyIntent(context, target)
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
}

class ConversationReplyReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val target = parseConversationNotificationReplyIntent(intent) ?: return
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
    runCatching { NodeForegroundService.resume(context, startNow = true) }
    app.launchRuntimeTask {
      try {
        val idempotencyKey = conversationNotificationReplyIdempotencyKey(target)
        var runtime: NodeRuntime? = null
        val sent =
          sendConversationNotificationReplyWithRecovery(
            timeoutMs = replyTimeoutMs,
            send = {
              val resolvedRuntime = app.ensureBackgroundRuntime()
              runtime = resolvedRuntime
              resolvedRuntime.sendConversationNotificationReply(
                target = target,
                reply = reply,
                idempotencyKey = idempotencyKey,
              )
            },
            wasAdmitted = {
              runtime?.wasChatOutboxCommandAdmitted(idempotencyKey) == true
            },
          )
        val notifier = ConversationReplyNotifier(context.applicationContext)
        if (sent) {
          runCatching { notifier.cancel(target) }
        } else {
          runCatching { notifier.showSendFailure(target) }
        }
      } finally {
        pendingResult.finish()
      }
    }
  }
}
