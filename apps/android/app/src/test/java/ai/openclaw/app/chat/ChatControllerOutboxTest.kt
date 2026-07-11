package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

private data class DeliveredSend(
  val key: String,
  val message: String,
  val sessionKey: String,
)

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerOutboxTest {
  private val json = Json { ignoreUnknownKeys = true }

  private class LoadGate(
    var remainingLoads: Int,
    val entered: CompletableDeferred<Unit>,
    val release: CompletableDeferred<Unit>,
  )

  /** In-memory stand-in for the Room outbox; Room persistence itself is covered by [RoomChatCommandOutboxTest]. */
  private class FakeCommandOutbox(
    private val capacity: Int = OUTBOX_MAX_QUEUED,
  ) : ChatCommandOutbox {
    val rows = LinkedHashMap<String, ChatOutboxItem>()
    val attachmentBytes = mutableMapOf<String, List<ByteArray>>()
    val gatewayIds = mutableMapOf<String, String>()
    val deletedSessions = mutableListOf<String>()
    var recoveryGate: CompletableDeferred<Unit>? = null
    var recoveryFailure: Throwable? = null
    var failedStatusUpdateFailure: Throwable? = null
    var acceptedStatusUpdateFailure: Throwable? = null
    var queuedStatusUpdateFailure: Throwable? = null
    var sendingStatusUpdateFailure: Throwable? = null
    var pinSessionKeyFailure: Throwable? = null
    var claimGate: CompletableDeferred<Unit>? = null
    var deleteFailure: Throwable? = null
    var deleteOnFailedStatus = false
    var loadGate: LoadGate? = null
    var onStatusUpdated: ((ChatOutboxStatus) -> Unit)? = null
    private var nextCreatedAt = 0L

    fun seed(
      item: ChatOutboxItem,
      gatewayId: String = "gateway-test",
    ) {
      rows[item.id] = item
      gatewayIds[item.id] = gatewayId
      nextCreatedAt = maxOf(nextCreatedAt, item.createdAtMs + 1)
    }

    override suspend fun load(gatewayId: String): List<ChatOutboxItem> {
      loadGate?.let { gate ->
        if (gate.remainingLoads == 0) {
          loadGate = null
          gate.entered.complete(Unit)
          gate.release.await()
        } else {
          gate.remainingLoads -= 1
        }
      }
      return rows.values
        .filter { gatewayIds[it.id] == gatewayId }
        .sortedWith(compareBy({ it.createdAtMs }, { it.id }))
    }

    override suspend fun enqueue(
      gatewayId: String,
      sessionKey: String,
      text: String,
      thinkingLevel: String,
      nowMs: Long,
      attachments: List<OutboxAttachmentPayload>,
      gatedEpoch: Long?,
    ): ChatOutboxEnqueueResult {
      if (gatewayIds.values.count { it == gatewayId } >= capacity) return ChatOutboxEnqueueResult.QueueFull
      val commandBytes = attachments.sumOf { it.bytes.size.toLong() }
      if (commandBytes > OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES) return ChatOutboxEnqueueResult.AttachmentsTooLarge
      val queuedBytes = attachmentBytes.values.sumOf { list -> list.sumOf { it.size.toLong() } }
      if (commandBytes > 0 && queuedBytes + commandBytes > OUTBOX_MAX_GATEWAY_ATTACHMENT_BYTES) {
        return ChatOutboxEnqueueResult.StorageFull
      }
      val createdAt = maxOf(nowMs, nextCreatedAt)
      nextCreatedAt = createdAt + 1
      val id = UUID.randomUUID().toString()
      val item =
        ChatOutboxItem(
          id = id,
          sessionKey = sessionKey,
          text = text,
          thinkingLevel = thinkingLevel,
          createdAtMs = createdAt,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
          gatedEpoch = gatedEpoch,
          attachments =
            attachments.mapIndexed { index, payload ->
              ChatOutboxAttachment(
                id = "$id-$index",
                type = payload.type,
                mimeType = payload.mimeType,
                fileName = payload.fileName,
                durationMs = payload.durationMs,
                byteLength = payload.bytes.size.toLong(),
              )
            },
        )
      rows[item.id] = item
      attachmentBytes[item.id] = attachments.map { it.bytes }
      gatewayIds[item.id] = gatewayId
      return ChatOutboxEnqueueResult.Queued(item)
    }

    override suspend fun loadAttachments(id: String): List<LoadedOutboxAttachment> {
      val item = rows[id] ?: return emptyList()
      val bytes = attachmentBytes[id].orEmpty()
      return item.attachments.mapIndexed { index, attachment ->
        LoadedOutboxAttachment(attachment = attachment, bytes = bytes[index])
      }
    }

    override suspend fun claimForSending(
      id: String,
      retryCount: Int,
      lastError: String?,
    ): Int {
      claimGate?.await()
      sendingStatusUpdateFailure?.let { throw it }
      val current = rows[id] ?: return 0
      if (current.status != ChatOutboxStatus.Queued) return 0
      rows[id] = current.copy(status = ChatOutboxStatus.Sending, retryCount = retryCount, lastError = lastError)
      onStatusUpdated?.invoke(ChatOutboxStatus.Sending)
      return 1
    }

    override suspend fun pinSessionKey(
      id: String,
      sessionKey: String,
    ) {
      pinSessionKeyFailure?.let { throw it }
      val current = rows[id] ?: return
      rows[id] = current.copy(sessionKey = sessionKey)
    }

    override suspend fun confirmDelivered(ids: Set<String>): Int {
      var removed = 0
      for (id in ids) {
        if (rows.remove(id) != null) {
          attachmentBytes.remove(id)
          gatewayIds.remove(id)
          removed += 1
        }
      }
      return removed
    }

    override suspend fun updateStatus(
      id: String,
      status: ChatOutboxStatus,
      retryCount: Int,
      lastError: String?,
    ): Int {
      if (status == ChatOutboxStatus.Failed && deleteOnFailedStatus) {
        rows.remove(id)
        gatewayIds.remove(id)
        return 0
      }
      if (status == ChatOutboxStatus.Failed) failedStatusUpdateFailure?.let { throw it }
      if (status == ChatOutboxStatus.Accepted) acceptedStatusUpdateFailure?.let { throw it }
      if (status == ChatOutboxStatus.Queued) queuedStatusUpdateFailure?.let { throw it }
      if (status == ChatOutboxStatus.Sending) sendingStatusUpdateFailure?.let { throw it }
      val current = rows[id] ?: return 0
      rows[id] = current.copy(status = status, retryCount = retryCount, lastError = lastError)
      onStatusUpdated?.invoke(status)
      return 1
    }

    override suspend fun requeueForRetry(
      gatewayId: String,
      id: String,
      nowMs: Long,
      gatedEpoch: Long?,
    ): Int {
      val current = rows[id] ?: return 0
      if (gatewayIds[id] != gatewayId || current.status != ChatOutboxStatus.Failed) return 0
      var createdAt = maxOf(nowMs, nextCreatedAt)
      rows[id] =
        current.copy(
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
          createdAtMs = createdAt,
          gatedEpoch = gatedEpoch,
        )
      // Mirror the Room store: queued same-session successors follow the retried row.
      val successors =
        rows.values
          .filter {
            it.id != id &&
              gatewayIds[it.id] == gatewayId &&
              it.sessionKey == current.sessionKey &&
              it.createdAtMs > current.createdAtMs &&
              it.status == ChatOutboxStatus.Queued
          }.sortedBy { it.createdAtMs }
      for (successor in successors) {
        createdAt += 1
        rows[successor.id] = successor.copy(createdAtMs = createdAt)
      }
      nextCreatedAt = createdAt + 1
      return 1
    }

    override suspend fun delete(id: String) {
      deleteFailure?.let { throw it }
      rows.remove(id)
      attachmentBytes.remove(id)
      gatewayIds.remove(id)
    }

    override suspend fun deleteForSession(
      gatewayId: String,
      sessionKey: String,
    ) {
      deletedSessions += sessionKey
      val ids = rows.values.filter { gatewayIds[it.id] == gatewayId && it.sessionKey == sessionKey }.map { it.id }
      ids.forEach {
        rows.remove(it)
        attachmentBytes.remove(it)
        gatewayIds.remove(it)
      }
    }

    override suspend fun clearGateway(gatewayId: String) {
      val ids = gatewayIds.filterValues { it == gatewayId }.keys.toList()
      ids.forEach {
        rows.remove(it)
        attachmentBytes.remove(it)
        gatewayIds.remove(it)
      }
    }

    override suspend fun failSendingAfterRestart() {
      recoveryGate?.await()
      recoveryFailure?.let { throw it }
      for ((id, item) in rows) {
        if (item.status == ChatOutboxStatus.Sending) {
          rows[id] = item.copy(status = ChatOutboxStatus.Failed, lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
        }
      }
    }

    override suspend fun expireStale(
      gatewayId: String,
      nowMs: Long,
    ) {
      for ((id, item) in rows) {
        if (gatewayIds[id] != gatewayId || item.createdAtMs > nowMs - OUTBOX_EXPIRY_MS) continue
        if (item.status == ChatOutboxStatus.Queued) {
          rows[id] = item.copy(status = ChatOutboxStatus.Failed, lastError = OUTBOX_EXPIRED_ERROR)
        } else if (item.status == ChatOutboxStatus.Accepted) {
          rows[id] = item.copy(status = ChatOutboxStatus.Failed, lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
        }
      }
    }
  }

  /**
   * Toggleable gateway seam: records chat.send idempotency keys and echoes them as run ids.
   * Sends that returned an acknowledgement are echoed into chat.history as `<key>:user` rows
   * plus an assistant reply, mirroring how the real gateway persists delivered turns; sends
   * that threw after dispatch are not echoed (their persistence is genuinely unknown).
   */
  private inner class FakeGateway {
    var online = false
    var sendFailureBeforeDispatch: Throwable? = null
    var sendFailureAfterDispatch: Throwable? = null
    var sendGate: CompletableDeferred<Unit>? = null
    var sendResponse: (idempotencyKey: String) -> String = { key -> """{"runId":"$key","status":"started"}""" }
    val sentIdempotencyKeys = mutableListOf<String>()
    val sentMessages = mutableListOf<String>()
    val sentSessionKeys = mutableListOf<String>()
    val sentThinkingLevels = mutableListOf<String>()
    val sentAttachmentFileNames = mutableListOf<List<String>>()
    var echoDeliveredSendsInHistory = true
    private val deliveredSends = mutableListOf<DeliveredSend>()
    var historyMessagesJson = "[]"
    var metadataModelsJson = "[]"

    suspend fun request(
      method: String,
      paramsJson: String?,
    ): String {
      if (!online) throw IllegalStateException("offline")
      return when (method) {
        "chat.send" -> {
          sendFailureBeforeDispatch?.let { throw it }
          val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
          val key = (params["idempotencyKey"] as JsonPrimitive).content
          val message = (params["message"] as JsonPrimitive).content
          val sessionKey = (params["sessionKey"] as JsonPrimitive).content
          sentIdempotencyKeys += key
          sentMessages += message
          sentSessionKeys += sessionKey
          sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
          sentAttachmentFileNames +=
            (params["attachments"] as? JsonArray)
              ?.mapNotNull { ((it as? JsonObject)?.get("fileName") as? JsonPrimitive)?.content }
              .orEmpty()
          sendFailureAfterDispatch?.let { throw it }
          sendGate?.await()
          val response = sendResponse(key)
          // Terminal failures never persist a turn; every other returned ack means the gateway
          // accepted the dispatch and the turn becomes visible in canonical history.
          val status =
            runCatching { (json.parseToJsonElement(response) as? JsonObject)?.get("status") as? JsonPrimitive }
              .getOrNull()
              ?.content
          if (status != "timeout" && status != "error") {
            deliveredSends += DeliveredSend(key = key, message = message, sessionKey = sessionKey)
          }
          response
        }
        "chat.history" -> {
          val requestedKey =
            runCatching {
              ((json.parseToJsonElement(paramsJson.orEmpty()) as? JsonObject)?.get("sessionKey") as? JsonPrimitive)?.content
            }.getOrNull()
          val echoed =
            if (echoDeliveredSendsInHistory) {
              deliveredSends
                .filter { requestedKey == null || it.sessionKey == requestedKey }
                .flatMapIndexed { index, send ->
                  listOf(
                    """{"role":"user","content":"${send.message}","timestamp":${100 + index * 2},"idempotencyKey":"${send.key}:user"}""",
                    """{"role":"assistant","content":"reply","timestamp":${101 + index * 2},"idempotencyKey":"${send.key}:assistant"}""",
                  )
                }
            } else {
              emptyList()
            }
          val explicit =
            (json.parseToJsonElement(historyMessagesJson) as JsonArray).map { it.toString() }
          """{"sessionId":"session-1","messages":[${(explicit + echoed).joinToString(",")}]}"""
        }
        "chat.metadata" -> """{"commands":[],"models":$metadataModelsJson}"""
        else -> "{}"
      }
    }
  }

  private fun controller(
    scope: CoroutineScope,
    gateway: FakeGateway,
    outbox: ChatCommandOutbox,
  ): ChatController =
    ChatController(
      scope = scope,
      json = json,
      requestGateway = gateway::request,
      cacheScope = { ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = 1L) },
      commandOutbox = outbox,
    )

  @Test
  fun enqueueWhileOfflineShowsQueuedRowAndSurvivesControllerRecreation() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val first = controller(this, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      assertFalse(first.healthOk.value)

      val accepted = first.sendMessageAwaitAcceptance(message = "offline hello", thinkingLevel = "off", attachments = emptyList())

      assertTrue(accepted)
      val queuedRow = first.outboxItems.value.single()
      assertEquals("offline hello", queuedRow.text)
      assertEquals(ChatOutboxStatus.Queued, queuedRow.status)

      // Recreated controller (fresh process analog) republishes the durable row.
      val second = controller(this, gateway, outbox)
      advanceUntilIdle()
      assertEquals(listOf("offline hello"), second.outboxItems.value.map { it.text })
    }

  @Test
  fun reconnectFlushesQueuedCommandsInOrderWithRowIdsAsIdempotencyKeys() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      chat.sendMessageAwaitAcceptance(message = "one", thinkingLevel = "high", attachments = emptyList())
      chat.sendMessageAwaitAcceptance(message = "two", thinkingLevel = "off", attachments = emptyList())
      chat.sendMessageAwaitAcceptance(message = "three", thinkingLevel = "off", attachments = emptyList())
      val queuedIds = chat.outboxItems.value.map { it.id }
      assertEquals(3, queuedIds.size)
      // A later selector change must not rewrite the thinking level of already-queued sends.
      chat.setThinkingLevel("low")

      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("one", "two", "three"), gateway.sentMessages)
      assertEquals(queuedIds, gateway.sentIdempotencyKeys)
      assertEquals(listOf("main", "main", "main"), gateway.sentSessionKeys)
      assertEquals(listOf("high", "off", "off"), gateway.sentThinkingLevels)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun knownAdmissionAcksWithRunIdsRemoveRows() =
    runTest {
      for (status in listOf("started", "in_flight", "ok")) {
        val gateway = FakeGateway()
        val outbox = FakeCommandOutbox()
        val chat = controller(this, gateway, outbox)
        chat.load("main")
        advanceUntilIdle()
        chat.sendMessageAwaitAcceptance(
          message = status,
          thinkingLevel = "off",
          attachments = emptyList(),
        )

        gateway.online = true
        gateway.sendResponse = { key -> """{"runId":"$key","status":"$status"}""" }
        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()

        assertEquals(listOf(status), gateway.sentMessages)
        assertTrue(chat.outboxItems.value.isEmpty())
      }
    }

  @Test
  fun failedAcceptedPersistenceRearmsRecoveryBeforeYoungerRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "accepted",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      // The acknowledged transition to accepted cannot be made durable; the flush must stop
      // before younger rows instead of advancing past an ambiguous head still marked sending.
      gateway.echoDeliveredSendsInHistory = false
      outbox.acceptedStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("accepted"), gateway.sentMessages)
      assertFalse(chat.healthOk.value)
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .first { it.text == "accepted" }
          .status,
      )
      assertEquals(
        ChatOutboxStatus.Queued,
        outbox.rows.values
          .first { it.text == "younger" }
          .status,
      )

      outbox.acceptedStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      // Bounded advance: enough for recovery, the flush, and its reconcile passes, but before
      // the pending-run timeout would park the still-unproven younger send.
      advanceTimeBy(5_000)
      runCurrent()

      // The re-armed recovery sweep parks the interrupted head for review and the younger row
      // proceeds; the parked head no longer blocks the session.
      assertEquals(listOf("accepted", "younger"), gateway.sentMessages)
      val parked = outbox.rows.values.first { it.text == "accepted" }
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .first { it.text == "younger" }
          .status,
      )
    }

  @Test
  fun reconnectGatesActiveSessionThinkingAndFailsOpenForOtherSessions() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      // Gating reads the controller-owned agent-scoped catalog hydrated from chat.metadata,
      // so hydrate first (empty queue) and seed the rows afterwards; the flush loop re-reads
      // the outbox on each health transition.
      gateway.metadataModelsJson =
        """[{"id":"plain","name":"Plain","provider":"openai","available":true,"input":["text"],"reasoning":false}]"""
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      outbox.seed(
        ChatOutboxItem(
          id = "active",
          sessionKey = "main",
          text = "active session",
          thinkingLevel = "high",
          createdAtMs = now,
          status = ChatOutboxStatus.Failed,
          retryCount = 0,
          lastError = "retry manually",
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "other",
          sessionKey = "other-session",
          text = "unknown session",
          thinkingLevel = "medium",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      assertTrue(chat.setSessionModelAwait("main", "openai/plain"))
      // Drop health via a transport failure mid-flush: unlike a disconnect this keeps the
      // hydrated catalog, which is the state where the flush gate has data to act on.
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      chat.retryOutboxCommand("active")
      advanceUntilIdle()
      assertFalse(chat.healthOk.value)

      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // retryOutboxCommand refreshes the active row's createdAt, so the untouched
      // unknown-session row flushes first in createdAt order.
      assertEquals(listOf("unknown session", "active session"), gateway.sentMessages)
      assertEquals(listOf("medium", "off"), gateway.sentThinkingLevels)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun mainAliasRowsFlushToCanonicalMainSessionAfterHello() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "queued pre-hello", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      assertEquals("main", queuedRow.sessionKey)

      // Gateway hello announces the canonical main session key, then health recovers.
      gateway.online = true
      chat.applyMainSessionKey("agent:work:main")
      advanceUntilIdle()
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("agent:work:main"), gateway.sentSessionKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun queuedRowsStayWithTheirGatewayAcrossSwitchAndFlushAfterSwitchBack() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      var activeScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1L)
      val chat =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          cacheScope = { activeScope },
          commandOutbox = outbox,
        )
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "gateway A queued", thinkingLevel = "off", attachments = emptyList())
      val queuedId =
        chat.outboxItems.value
          .single()
          .id

      activeScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2L)
      chat.onGatewayScopeChanging()
      chat.onDisconnected("Offline")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(gateway.sentMessages.isEmpty())
      assertTrue(chat.outboxItems.value.isEmpty())
      assertEquals(listOf(queuedId), outbox.load("gateway-a").map { it.id })
      assertTrue(outbox.load("gateway-b").isEmpty())

      activeScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 3L)
      chat.onGatewayScopeChanging()
      chat.onDisconnected("Offline")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("gateway A queued"), gateway.sentMessages)
      assertTrue(outbox.load("gateway-a").isEmpty())
    }

  @Test
  fun terminalFailureAcksFailUnconfirmedWithoutReplay() =
    runTest {
      val responses =
        listOf<(String) -> String>(
          { key -> """{"runId":"$key","status":"error"}""" },
          { key -> """{"runId":"$key","status":"timeout"}""" },
          { _ -> """{"status":"error"}""" },
          { _ -> """{"status":"timeout"}""" },
        )

      for ((index, response) in responses.withIndex()) {
        val gateway = FakeGateway()
        val outbox = FakeCommandOutbox()
        val chat = controller(this, gateway, outbox)
        chat.load("main")
        advanceUntilIdle()
        chat.sendMessageAwaitAcceptance(message = "terminal-$index", thinkingLevel = "off", attachments = emptyList())

        gateway.online = true
        gateway.sendResponse = response
        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()

        val failed = chat.outboxItems.value.single()
        assertEquals(ChatOutboxStatus.Failed, failed.status)
        assertEquals(0, failed.retryCount)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
        assertEquals(1, gateway.sentMessages.size)
        assertTrue(chat.healthOk.value)

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()
        assertEquals(1, gateway.sentMessages.size)
      }
    }

  @Test
  fun acknowledgedFailureKeepsGatewayOnlineAndFlushesLaterRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "fails",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "continues",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      gateway.online = true
      gateway.sendResponse = { key ->
        if (gateway.sentMessages.size == 1) {
          """{"runId":"$key","status":"error"}"""
        } else {
          """{"runId":"$key","status":"started"}"""
        }
      }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(chat.healthOk.value)
      assertEquals(listOf("fails", "continues"), gateway.sentMessages)
      val failed = chat.outboxItems.value.single()
      assertEquals("fails", failed.text)
      assertEquals(ChatOutboxStatus.Failed, failed.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
    }

  @Test
  fun failedFailurePersistenceStopsBeforeYoungerRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "ambiguous",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      outbox.failedStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      gateway.sendResponse = { key -> """{"runId":"$key","status":"error"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("ambiguous"), gateway.sentMessages)
      assertFalse(chat.healthOk.value)
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .first { it.text == "ambiguous" }
          .status,
      )
      assertEquals(
        ChatOutboxStatus.Queued,
        outbox.rows.values
          .first { it.text == "younger" }
          .status,
      )

      outbox.failedStatusUpdateFailure = null
      gateway.sendResponse = { key -> """{"runId":"$key","status":"started"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("ambiguous", "younger"), gateway.sentMessages)
      val recovered = chat.outboxItems.value.single()
      assertEquals("ambiguous", recovered.text)
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)

      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("ambiguous", "younger"), gateway.sentMessages)
      assertEquals(
        ChatOutboxStatus.Failed,
        restarted.outboxItems.value
          .single()
          .status,
      )
    }

  @Test
  fun failedClaimPersistenceStopsBeforeDispatch() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "older",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      outbox.sendingStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(gateway.sentMessages.isEmpty())
      assertFalse(chat.healthOk.value)
      assertEquals(
        listOf(ChatOutboxStatus.Queued, ChatOutboxStatus.Queued),
        outbox.rows.values.map { it.status },
      )

      outbox.sendingStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("older", "younger"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun failedNotDispatchedPersistenceRearmsRecoveryBeforeYoungerRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "older",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      outbox.queuedStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(gateway.sentMessages.isEmpty())
      assertFalse(chat.healthOk.value)
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .first { it.text == "older" }
          .status,
      )
      assertEquals(
        ChatOutboxStatus.Queued,
        outbox.rows.values
          .first { it.text == "younger" }
          .status,
      )

      outbox.queuedStatusUpdateFailure = null
      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("younger"), gateway.sentMessages)
      val recovered = chat.outboxItems.value.single()
      assertEquals("older", recovered.text)
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
    }

  @Test
  fun transmittedGatewayRejectionNeverReplaysUntilExplicitRetryAcrossRestart() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "manual retry only", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch =
        GatewayRequestRejected(GatewaySession.ErrorShape(code = "UNAVAILABLE", message = "cached run failed"))
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val ambiguous = first.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, ambiguous.status)
      assertEquals(0, ambiguous.retryCount)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, ambiguous.lastError)
      assertEquals(1, gateway.sentMessages.size)
      assertTrue(first.healthOk.value)
      processJob.cancel()

      gateway.sendFailureAfterDispatch = null
      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(1, gateway.sentMessages.size)
      assertEquals(
        ChatOutboxStatus.Failed,
        restarted.outboxItems.value
          .single()
          .status,
      )

      restarted.retryOutboxCommand(ambiguous.id)
      advanceUntilIdle()
      assertEquals(listOf(ambiguous.id, ambiguous.id), gateway.sentIdempotencyKeys)
      assertTrue(restarted.outboxItems.value.isEmpty())
    }

  @Test
  fun migratedAmbiguousRowNeverSendsUntilExplicitRetry() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "migrated-ambiguous",
          sessionKey = "main",
          text = "possibly delivered before upgrade",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Failed,
          retryCount = 0,
          lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(gateway.sentMessages.isEmpty())
      assertEquals(
        ChatOutboxStatus.Failed,
        chat.outboxItems.value
          .single()
          .status,
      )

      chat.retryOutboxCommand("migrated-ambiguous")
      advanceUntilIdle()
      assertEquals(listOf("migrated-ambiguous"), gateway.sentIdempotencyKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun notDispatchedKeepsRowQueuedForNextReconnectInsteadOfBurningAttempts() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "survives drops", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // The frame never entered the socket queue, so reconnect may retry it automatically.
      val row = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Queued, row.status)
      assertEquals(0, row.retryCount)
      assertTrue(gateway.sentMessages.isEmpty())
      assertFalse(chat.healthOk.value)

      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("survives drops"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun deletedUnknownOutcomeStillStopsBeforeYoungerRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "older",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      outbox.deleteOnFailedStatus = true
      gateway.online = true
      gateway.sendFailureAfterDispatch = GatewayRequestOutcomeUnknown("ack lost")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("older"), gateway.sentMessages)
      assertFalse(chat.healthOk.value)
      assertEquals(listOf("younger"), chat.outboxItems.value.map { it.text })

      outbox.deleteOnFailedStatus = false
      gateway.sendFailureAfterDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("older", "younger"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun healthFlushRequestDuringActiveFlushIsDrainedAfterRelease() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "ambiguous",
        thinkingLevel = "off",
        attachments = emptyList(),
      )
      chat.sendMessageAwaitAcceptance(
        message = "younger",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      val finalPublishEntered = CompletableDeferred<Unit>()
      val releaseFinalPublish = CompletableDeferred<Unit>()
      outbox.onStatusUpdated = { status ->
        if (status == ChatOutboxStatus.Failed) {
          outbox.onStatusUpdated = null
          // The first load republishes Failed; the second is the owning flush's finally block.
          outbox.loadGate =
            LoadGate(
              remainingLoads = 1,
              entered = finalPublishEntered,
              release = releaseFinalPublish,
            )
        }
      }
      gateway.online = true
      gateway.sendFailureAfterDispatch = GatewayRequestOutcomeUnknown("ack lost")
      chat.handleGatewayEvent("health", null)
      runCurrent()
      finalPublishEntered.await()

      assertEquals(listOf("ambiguous"), gateway.sentMessages)
      assertFalse(chat.healthOk.value)
      gateway.sendFailureAfterDispatch = null
      chat.handleGatewayEvent("health", null)
      runCurrent()
      assertEquals(listOf("ambiguous"), gateway.sentMessages)

      releaseFinalPublish.complete(Unit)
      advanceUntilIdle()

      assertEquals(listOf("ambiguous", "younger"), gateway.sentMessages)
      val failed = chat.outboxItems.value.single()
      assertEquals("ambiguous", failed.text)
      assertEquals(ChatOutboxStatus.Failed, failed.status)
    }

  @Test
  fun droppedAckFailsUnconfirmedAndNeverReplaysUntilExplicitRetry() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val first = controller(this, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "send once", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch = GatewayRequestOutcomeUnknown("ack lost")
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val ambiguous = first.outboxItems.value.single()
      assertEquals(listOf("send once"), gateway.sentMessages)
      assertFalse(first.healthOk.value)

      gateway.sendFailureAfterDispatch = null
      first.handleGatewayEvent("health", null)
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()
      // Reconnect must not replay an ambiguous row; only the explicit retry below may dispatch it.
      assertEquals(1, gateway.sentMessages.size)
      assertEquals(ChatOutboxStatus.Failed, ambiguous.status)
      assertEquals(0, ambiguous.retryCount)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, ambiguous.lastError)

      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(1, gateway.sentMessages.size)
      assertEquals(
        ChatOutboxStatus.Failed,
        restarted.outboxItems.value
          .single()
          .status,
      )

      restarted.retryOutboxCommand(ambiguous.id)
      advanceUntilIdle()
      assertEquals(listOf(ambiguous.id, ambiguous.id), gateway.sentIdempotencyKeys)
      assertTrue(restarted.outboxItems.value.isEmpty())
    }

  @Test
  fun runIdOnlyAckFailsUnconfirmed() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(
        message = "missing status",
        thinkingLevel = "off",
        attachments = emptyList(),
      )

      gateway.online = true
      gateway.sendResponse = { key -> """{"runId":"$key"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("missing status"), gateway.sentMessages)
      val failed = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, failed.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
      assertTrue(chat.healthOk.value)
    }

  @Test
  fun unknownOrMalformedAckFailsUnconfirmed() =
    runTest {
      val responses =
        listOf<(String) -> String>(
          { key -> """{"runId":"$key","status":"mystery"}""" },
          { key -> """{"runId":"$key","status":"accepted"}""" },
          { _ -> """{"status":"accepted"}""" },
          { _ -> """{"status":"started"}""" },
          { _ -> """{"status":"in_flight"}""" },
          { key -> """{"runId":"$key","status":42}""" },
          { key -> """{"runId":"$key","status":null}""" },
          { key -> """{"runId":"$key","status":" "}""" },
          { _ -> "not-json" },
        )

      for ((index, response) in responses.withIndex()) {
        val gateway = FakeGateway()
        val outbox = FakeCommandOutbox()
        val chat = controller(this, gateway, outbox)
        chat.load("main")
        advanceUntilIdle()
        chat.sendMessageAwaitAcceptance(message = "unknown-$index", thinkingLevel = "off", attachments = emptyList())
        gateway.online = true
        gateway.sendResponse = response

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()

        val failed = chat.outboxItems.value.single()
        assertEquals(ChatOutboxStatus.Failed, failed.status)
        assertEquals(0, failed.retryCount)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
        assertEquals(1, gateway.sentMessages.size)
        assertTrue(chat.healthOk.value)

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()
        assertEquals(1, gateway.sentMessages.size)
      }
    }

  @Test
  fun terminalSuccessAckWithoutRunIdFailsUnconfirmed() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "completed ack", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendResponse = { _ -> """{"status":"ok"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("completed ack"), gateway.sentMessages)
      val failed = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, failed.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
      assertTrue(chat.healthOk.value)
    }

  @Test
  fun retryResetsFailedRowAndFlushesImmediately() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "failed-row",
          sessionKey = "main",
          text = "try me again",
          thinkingLevel = "off",
          // Recent timestamp: the startup/flush expiry sweep must not expire this row.
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Failed,
          retryCount = 2,
          lastError = "boom",
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.healthOk.value)
      val seededRow = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, seededRow.status)

      chat.retryOutboxCommand("failed-row")
      advanceUntilIdle()

      assertEquals(listOf("failed-row"), gateway.sentIdempotencyKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun deleteRemovesQueuedRow() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "delete me", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      val id = queuedRow.id

      chat.deleteOutboxCommand(id)
      advanceUntilIdle()

      assertTrue(chat.outboxItems.value.isEmpty())
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun queueFullRefusalSurfacesErrorWithoutQueueing() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox(capacity = 1)
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.sendMessageAwaitAcceptance(message = "fits", thinkingLevel = "off", attachments = emptyList()))

      val accepted = chat.sendMessageAwaitAcceptance(message = "overflow", thinkingLevel = "off", attachments = emptyList())

      assertFalse(accepted)
      assertEquals(1, outbox.rows.size)
      val errorText = chat.errorText.value.orEmpty()
      assertTrue(errorText.contains("full"))
    }

  @Test
  fun sendingRowsBecomeDeliveryUnconfirmedOnControllerStartup() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "crashed mid-send",
          thinkingLevel = "off",
          // Recent timestamp: startup recovery must surface this row before any retry decision.
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Sending,
          retryCount = 1,
          lastError = "socket closed",
        ),
      )

      val chat = controller(this, gateway, outbox)
      advanceUntilIdle()

      val recovered = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
      assertEquals(1, recovered.retryCount)
    }

  @Test
  fun startupRecoveryFinishesBeforeAHealthFlushCanClaimQueuedRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val recoveryGate = CompletableDeferred<Unit>()
      outbox.recoveryGate = recoveryGate
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "already dispatched",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Sending,
          retryCount = 1,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued",
          sessionKey = "main",
          text = "send after recovery",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )

      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      runCurrent()

      try {
        assertTrue(gateway.sentMessages.isEmpty())
        assertEquals(ChatOutboxStatus.Sending, outbox.rows.getValue("interrupted").status)
        assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("queued").status)
      } finally {
        // Never strand the controller's child job if a pre-release assertion fails.
        recoveryGate.complete(Unit)
      }
      advanceUntilIdle()

      assertEquals(listOf("send after recovery"), gateway.sentMessages)
      assertEquals(ChatOutboxStatus.Failed, outbox.rows.getValue("interrupted").status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, outbox.rows.getValue("interrupted").lastError)
      assertFalse(outbox.rows.containsKey("queued"))
    }

  @Test
  fun startupRecoveryFailureBlocksFlushUntilRecoveryCanBeRetried() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "possibly delivered",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Sending,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued",
          sessionKey = "main",
          text = "younger queued work",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.recoveryFailure = IllegalStateException("database unavailable")
      val chat = controller(this, gateway, outbox)

      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertFalse(chat.healthOk.value)
      assertTrue(gateway.sentMessages.isEmpty())
      assertEquals(ChatOutboxStatus.Sending, outbox.rows.getValue("interrupted").status)
      assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("queued").status)

      outbox.recoveryFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(ChatOutboxStatus.Failed, outbox.rows.getValue("interrupted").status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, outbox.rows.getValue("interrupted").lastError)
      assertEquals(listOf("younger queued work"), gateway.sentMessages)
      assertFalse(outbox.rows.containsKey("queued"))
    }

  @Test
  fun cancellationLeavesTheClaimForStartupRecoveryInsteadOfReplaying() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "interrupted send", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch = CancellationException("process stopping")
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("interrupted send"), gateway.sentMessages)
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .single()
          .status,
      )
      processJob.cancel()

      gateway.sendFailureAfterDispatch = null
      val restarted = controller(this, gateway, outbox)
      advanceUntilIdle()

      val recovered = restarted.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(1, gateway.sentMessages.size)
    }

  @Test
  fun staleQueuedRowsExpireToFailedInsteadOfSendingOnReconnect() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "stale",
          sessionKey = "main",
          text = "two days old",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis() - OUTBOX_EXPIRY_MS,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(gateway.sentIdempotencyKeys.isEmpty())
      val expired = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, expired.status)
      assertEquals(OUTBOX_EXPIRED_ERROR, expired.lastError)

      // Retrying an expired row refreshes its createdAt, so the flush sweep cannot
      // immediately re-expire it and the send actually happens.
      chat.retryOutboxCommand("stale")
      advanceUntilIdle()
      assertEquals(listOf("stale"), gateway.sentIdempotencyKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun sessionDeleteEventPurgesThatSessionsOutboxRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "doomed-session-row",
          sessionKey = "agent:old:main",
          text = "orphaned",
          thinkingLevel = "off",
          createdAtMs = 5,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      advanceUntilIdle()

      chat.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"agent:old:main"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("agent:old:main"), outbox.deletedSessions)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun offlineAttachmentSendsQueueDurablyWithByteRecovery() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      val imageBytes = byteArrayOf(1, 2, 3, 4)
      val voiceBytes = byteArrayOf(9, 8, 7)
      val accepted =
        chat.sendMessageAwaitAcceptance(
          message = "with media",
          thinkingLevel = "off",
          attachments =
            listOf(
              OutgoingAttachment(
                type = "image",
                mimeType = "image/jpeg",
                fileName = "a.jpg",
                base64 =
                  java.util.Base64
                    .getEncoder()
                    .encodeToString(imageBytes),
              ),
              OutgoingAttachment(
                type = "audio",
                mimeType = "audio/mp4",
                fileName = "note.m4a",
                base64 =
                  java.util.Base64
                    .getEncoder()
                    .encodeToString(voiceBytes),
                durationMs = 1200L,
              ),
            ),
        )

      assertTrue(accepted)
      val queued = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Queued, queued.status)
      assertEquals(listOf("a.jpg", "note.m4a"), queued.attachments.map { it.fileName })
      assertEquals(1200L, queued.attachments[1].durationMs)
      // Exact bytes survive the round trip into durable storage.
      val loaded = outbox.loadAttachments(queued.id)
      assertTrue(imageBytes.contentEquals(loaded[0].bytes))
      assertTrue(voiceBytes.contentEquals(loaded[1].bytes))

      // Reconnect flushes the attachment payload with the captured metadata.
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf(listOf("a.jpg", "note.m4a")), gateway.sentAttachmentFileNames)
      assertTrue(chat.outboxItems.value.isEmpty())
      assertTrue(outbox.attachmentBytes.isEmpty())
    }

  @Test
  fun historyProofRetiresRowAndTheCanonicalCopyIsTheOnlyBubble() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      chat.sendMessageAwaitAcceptance(message = "queued text", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      val queuedId = queuedRow.id

      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(chat.outboxItems.value.isEmpty())
      val userCopies = chat.messages.value.filter { message -> message.content.any { it.text == "queued text" } }
      assertEquals(1, userCopies.size)
      assertEquals("$queuedId:user", userCopies.single().idempotencyKey)
    }

  @Test
  fun acceptedRowSurvivesUntilCanonicalHistoryConfirmsIt() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      chat.sendMessageAwaitAcceptance(message = "await proof", thinkingLevel = "off", attachments = emptyList())
      val queuedId =
        chat.outboxItems.value
          .single()
          .id

      // The gateway acks the send, but history lags: the durable row must not be deleted on
      // the ACK alone, or a gateway crash before the transcript write would lose the message.
      gateway.echoDeliveredSendsInHistory = false
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(listOf(queuedId), gateway.sentIdempotencyKeys)
      assertEquals(ChatOutboxStatus.Accepted, outbox.rows.getValue(queuedId).status)

      // Canonical history catches up and retires the row.
      gateway.echoDeliveredSendsInHistory = true
      chat.refresh()
      advanceUntilIdle()
      assertFalse(outbox.rows.containsKey(queuedId))
    }

  @Test
  fun healthySendsAreJournaledBeforeDispatchAndRetiredByHistoryProof() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.healthOk.value)

      gateway.echoDeliveredSendsInHistory = false
      val accepted = chat.sendMessageAwaitAcceptance(message = "healthy send", thinkingLevel = "off", attachments = emptyList())
      runCurrent()

      assertTrue(accepted)
      // The dispatch used the durable row id as its idempotency key, and the row survives the
      // started ACK: only canonical history proof may retire it.
      val row = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Accepted, row.status)
      assertEquals(listOf(row.id), gateway.sentIdempotencyKeys)
      assertEquals(1, chat.messages.value.count { it.idempotencyKey == "${row.id}:user" })

      gateway.echoDeliveredSendsInHistory = true
      chat.refresh()
      advanceUntilIdle()
      assertTrue(outbox.rows.isEmpty())
      assertEquals(1, chat.messages.value.count { it.idempotencyKey == "${row.id}:user" })
    }

  @Test
  fun processDeathDuringHealthyDispatchLeavesTheClaimForStartupRecovery() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      gateway.online = true
      first.load("main")
      advanceUntilIdle()

      gateway.sendFailureAfterDispatch = CancellationException("process died mid-send")
      runCatching { first.sendMessageAwaitAcceptance(message = "died in flight", thinkingLevel = "off", attachments = emptyList()) }
      processJob.cancel()

      // The row keeps its 'sending' claim; the next process surfaces it as delivery-unconfirmed
      // instead of silently replaying a possibly delivered dispatch.
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .single()
          .status,
      )
      gateway.sendFailureAfterDispatch = null
      gateway.echoDeliveredSendsInHistory = false
      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val recovered = restarted.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
      assertEquals(1, gateway.sentMessages.size)
    }

  @Test
  fun restartOrphanedAcceptedRowIsRetiredByHistoryProofWithoutResending() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "acked then killed", thinkingLevel = "off", attachments = emptyList())

      // Flush accepts the row, then the process dies before history could confirm it.
      gateway.echoDeliveredSendsInHistory = false
      gateway.online = true
      first.handleGatewayEvent("health", null)
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .single()
          .status,
      )
      processJob.cancel()

      // The next process proves the turn against canonical history and retires the row
      // without a second dispatch, even though the ACK was never locally processed further.
      gateway.echoDeliveredSendsInHistory = true
      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(outbox.rows.isEmpty())
      assertEquals(1, gateway.sentIdempotencyKeys.size)
    }

  @Test
  fun restartOrphanedAcceptedRowWithoutHistoryProofParksForManualReview() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "acked but lost", thinkingLevel = "off", attachments = emptyList())

      gateway.echoDeliveredSendsInHistory = false
      gateway.online = true
      first.handleGatewayEvent("health", null)
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .single()
          .status,
      )
      processJob.cancel()

      // The gateway lost the turn (crash between ACK and transcript write): an idle history
      // without the row's key parks it for explicit review instead of auto-retrying.
      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val parked = restarted.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
      assertEquals(1, gateway.sentIdempotencyKeys.size)

      // Explicit retry reuses the same idempotency key.
      restarted.retryOutboxCommand(parked.id)
      advanceUntilIdle()
      assertEquals(listOf(parked.id, parked.id), gateway.sentIdempotencyKeys)
    }

  @Test
  fun preHelloMainRowsArePinnedAtFirstDispatchAndNeverRetarget() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "pinned input", thinkingLevel = "off", attachments = emptyList())
      assertEquals(
        "main",
        outbox.rows.values
          .single()
          .sessionKey,
      )

      // First dispatch resolves the alias against the hello-announced main session and pins it.
      gateway.echoDeliveredSendsInHistory = false
      gateway.sendFailureAfterDispatch = GatewayRequestOutcomeUnknown("ack lost")
      gateway.online = true
      chat.applyMainSessionKey("agent:work:main")
      advanceUntilIdle()
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val parked = outbox.rows.values.single()
      assertEquals("agent:work:main", parked.sessionKey)
      assertEquals(ChatOutboxStatus.Failed, parked.status)

      // A later default-agent change must not redirect the captured input on retry.
      gateway.sendFailureAfterDispatch = null
      chat.applyMainSessionKey("agent:other:main")
      advanceUntilIdle()
      chat.retryOutboxCommand(parked.id)
      advanceUntilIdle()
      assertEquals(listOf("agent:work:main", "agent:work:main"), gateway.sentSessionKeys)
    }

  @Test
  fun gatedCommandRowsParkAcrossReconnectAndSendOnlyOnExplicitRetry() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      var generation = 1L
      val chat =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          cacheScope = { ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = generation) },
          commandOutbox = outbox,
        )
      chat.load("main")
      advanceUntilIdle()

      // A slash command captured offline is connection-gated to the epoch that captured it.
      chat.sendMessageAwaitAcceptance(message = "/clear", thinkingLevel = "off", attachments = emptyList())
      val row = outbox.rows.values.single()
      assertEquals(1L, row.gatedEpoch)

      // Reconnecting bumps the connection epoch, so the command parks instead of replaying.
      generation = 2L
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val parked = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_CONNECTION_CHANGED_ERROR, parked.lastError)
      assertTrue(gateway.sentMessages.isEmpty())

      // An explicit retry while connected re-arms the row for the live epoch and sends it.
      chat.retryOutboxCommand(parked.id)
      advanceUntilIdle()
      assertEquals(listOf("/clear"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun directSlashSendParksWhenReconnectLandsBeforeDispatch() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      var generation = 1L
      val chat =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          cacheScope = { ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = generation) },
          commandOutbox = outbox,
        )
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      // Hold the direct dispatch at its durable claim, then reconnect underneath it. The
      // command was captured under epoch 1 and must not auto-send on the new connection.
      outbox.claimGate = CompletableDeferred()
      var accepted: Boolean? = null
      val send =
        launch {
          accepted = chat.sendMessageAwaitAcceptance(message = "/clear", thinkingLevel = "off", attachments = emptyList())
        }
      runCurrent()
      generation = 2L
      outbox.claimGate?.complete(Unit)
      send.join()
      advanceUntilIdle()

      assertEquals(true, accepted)
      assertTrue(gateway.sentMessages.isEmpty())
      val parked = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_CONNECTION_CHANGED_ERROR, parked.lastError)
    }

  @Test
  fun acceptedRowAckedUnderDifferentRunIdStaysOwnedWhileTheRunIsLive() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      // The gateway acknowledges the send under a run id that differs from the row's
      // idempotency key; local ownership transfers to that id while the row keeps its own.
      gateway.sendResponse = { _ -> """{"runId":"gw-run-777","status":"started"}""" }
      gateway.echoDeliveredSendsInHistory = false
      chat.load("main")
      advanceUntilIdle()

      val accepted = chat.sendMessageAwaitAcceptance(message = "slow turn", thinkingLevel = "off", attachments = emptyList())
      advanceTimeBy(1_000)
      assertTrue(accepted)
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .single()
          .status,
      )

      // A follow-up send must see the accepted head as live-owned: it dispatches directly,
      // and the reconciliation sweep must not park the head while its run is in flight.
      val followUp = chat.sendMessageAwaitAcceptance(message = "second", thinkingLevel = "off", attachments = emptyList())
      advanceTimeBy(10_000)
      assertTrue(followUp)
      assertEquals(listOf("slow turn", "second"), gateway.sentMessages)
      assertTrue(outbox.rows.values.none { it.status == ChatOutboxStatus.Failed })
    }

  @Test
  fun flushedSendAckedUnderDifferentRunIdResolvesWithTheLiveRun() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.sendResponse = { _ -> """{"runId":"gw-run-9","status":"started"}""" }
      gateway.echoDeliveredSendsInHistory = false
      chat.load("main")
      advanceUntilIdle()

      // Captured offline, delivered by the reconnect flush under a divergent acked run id.
      chat.sendMessageAwaitAcceptance(message = "queued turn", thinkingLevel = "off", attachments = emptyList())
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceTimeBy(5_000)
      assertEquals(listOf("queued turn"), gateway.sentMessages)
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .single()
          .status,
      )

      // The run completes under the acknowledged id and its turn becomes visible in
      // canonical history. The adopted send must resolve with the live run: without the
      // ownership transfer the row-id pending run times out and surfaces a spurious error
      // for a turn that was delivered.
      gateway.echoDeliveredSendsInHistory = true
      chat.handleGatewayEvent("chat", chatTerminalPayload("main", "gw-run-9", seq = 1, state = "final", assistantText = "done"))
      advanceTimeBy(130_000)
      assertEquals(0, chat.pendingRunCount.value)
      assertTrue(outbox.rows.isEmpty())
      assertNull(chat.errorText.value)
    }

  @Test
  fun failedSessionPinKeepsTheRowQueuedInsteadOfDispatching() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      outbox.seed(
        ChatOutboxItem(
          id = "alias-row",
          sessionKey = "main",
          text = "captured pre-hello",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      chat.load("main")
      chat.applyMainSessionKey("agent:work:main")
      advanceUntilIdle()

      // The durable pin is the only record of the alias resolution; if it cannot persist,
      // dispatching anyway would let a retry after a default change target another session.
      outbox.pinSessionKeyFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(gateway.sentMessages.isEmpty())
      assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("alias-row").status)
      assertFalse(chat.healthOk.value)

      // Storage recovers; the next health transition pins and delivers exactly once.
      outbox.pinSessionKeyFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("agent:work:main"), gateway.sentSessionKeys)
      assertTrue(outbox.rows.values.none { it.sessionKey == "main" })
    }

  @Test
  fun reconcileParkWriteFailureFailsClosedThenParksAfterRecovery() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.echoDeliveredSendsInHistory = false
      outbox.seed(
        ChatOutboxItem(
          id = "orphan-row",
          sessionKey = "main",
          text = "ambiguous send",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Accepted,
          retryCount = 0,
          lastError = null,
        ),
      )
      chat.load("main")
      advanceUntilIdle()

      // Two sightings without proof want to park the row, but the write fails: health drops
      // instead of the reconciler claiming a change it never persisted.
      outbox.failedStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(ChatOutboxStatus.Accepted, outbox.rows.getValue("orphan-row").status)
      assertFalse(chat.healthOk.value)

      // Storage recovers; the next pass parks the orphan for manual review.
      outbox.failedStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val parked = outbox.rows.getValue("orphan-row")
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
    }

  @Test
  fun staleGatedParkFailureFailsClosedInsteadOfSpinning() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      outbox.seed(
        ChatOutboxItem(
          id = "stale-command",
          sessionKey = "main",
          text = "/clear",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
          gatedEpoch = 5L,
        ),
      )
      chat.load("main")
      advanceUntilIdle()

      // The park write fails; the flush must drop health and stop instead of reloading the
      // same stale row forever on a healthy connection.
      outbox.failedStatusUpdateFailure = IllegalStateException("storage unavailable")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertFalse(chat.healthOk.value)
      assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("stale-command").status)
      assertTrue(gateway.sentMessages.isEmpty())

      // Storage recovers; the next health transition parks the stale command for review.
      outbox.failedStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      val parked = outbox.rows.getValue("stale-command")
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_CONNECTION_CHANGED_ERROR, parked.lastError)
      assertTrue(gateway.sentMessages.isEmpty())
    }

  @Test
  fun orphanedAcceptedHeadBlocksItsSessionUntilReconciliationParksIt() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "ambiguous-a",
          sessionKey = "agent:a:main",
          text = "unresolved head",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Accepted,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued-a",
          sessionKey = "agent:a:main",
          text = "blocked successor",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued-b",
          sessionKey = "agent:b:main",
          text = "independent session",
          thinkingLevel = "off",
          createdAtMs = now + 2,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // The unproven accepted head held its session while the unrelated session flowed first;
      // once reconciliation parked it for review, the released successor followed.
      assertEquals(listOf("independent session", "blocked successor"), gateway.sentMessages)
      assertEquals(ChatOutboxStatus.Failed, outbox.rows.getValue("ambiguous-a").status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, outbox.rows.getValue("ambiguous-a").lastError)
      assertFalse(outbox.rows.containsKey("queued-a"))
      assertFalse(outbox.rows.containsKey("queued-b"))
    }

  @Test
  fun unconfirmedTimeoutParksTheAcceptedRowForReview() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      // The gateway accepts the dispatch but its turn never reaches canonical history.
      gateway.echoDeliveredSendsInHistory = false
      chat.sendMessageAwaitAcceptance(message = "never confirmed", thinkingLevel = "off", attachments = emptyList())
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Accepted,
        outbox.rows.values
          .single()
          .status,
      )

      // Run ownership expires without proof; the row surfaces for manual review.
      advanceUntilIdle()
      val parked = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
    }

  @Test
  fun callerCancellationAfterTheClaimDoesNotStrandTheDirectSend() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      // The UI scope dies (screen leaves composition) while the dispatch is suspended on the
      // gateway response; the controller-owned dispatch must still settle the claimed row.
      val gate = CompletableDeferred<Unit>()
      gateway.sendGate = gate
      val callerJob = SupervisorJob()
      val caller = CoroutineScope(coroutineContext + callerJob)
      caller.launch {
        chat.sendMessageAwaitAcceptance(message = "survives caller death", thinkingLevel = "off", attachments = emptyList())
      }
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .single()
          .status,
      )
      callerJob.cancel()
      gate.complete(Unit)
      advanceUntilIdle()

      // Delivered exactly once and retired by canonical history proof; nothing stranded.
      assertEquals(listOf("survives caller death"), gateway.sentMessages)
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun directSendClaimFailureHandsDeliveryToTheFlushLane() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      // The durable claim itself cannot be persisted; the admitted row must not be reported
      // as sent-with-no-owner. The flush lane takes over and fails closed on the same error.
      outbox.sendingStatusUpdateFailure = IllegalStateException("storage unavailable")
      val accepted = chat.sendMessageAwaitAcceptance(message = "owned by flush", thinkingLevel = "off", attachments = emptyList())
      advanceUntilIdle()
      assertTrue(accepted)
      assertEquals(
        ChatOutboxStatus.Queued,
        outbox.rows.values
          .single()
          .status,
      )
      assertTrue(gateway.sentMessages.isEmpty())
      assertFalse(chat.healthOk.value)

      // Storage recovers; the next health transition delivers the queued row exactly once.
      outbox.sendingStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("owned by flush"), gateway.sentMessages)
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun directSendPersistenceFailureRearmsRecoveryInsteadOfStrandingSending() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      // The acknowledged transition to accepted cannot be made durable mid-direct-send.
      gateway.echoDeliveredSendsInHistory = false
      outbox.acceptedStatusUpdateFailure = IllegalStateException("storage unavailable")
      chat.sendMessageAwaitAcceptance(message = "stranded claim", thinkingLevel = "off", attachments = emptyList())
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .single()
          .status,
      )
      assertFalse(chat.healthOk.value)

      // The re-armed recovery sweep parks the row on the next health transition, so the
      // session is not blocked forever by a claim with no user action available.
      outbox.acceptedStatusUpdateFailure = null
      chat.handleGatewayEvent("health", null)
      advanceTimeBy(5_000)
      runCurrent()
      val parked = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
    }

  @Test
  fun notEnqueuedDirectSendKeepsTheJournaledRowQueuedForReconnect() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.healthOk.value)

      // The frame never enters the socket queue mid-direct-send; the durable copy must stay
      // queued for reconnect instead of being deleted with only the volatile draft left.
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      val accepted = chat.sendMessageAwaitAcceptance(message = "survives direct drop", thinkingLevel = "off", attachments = emptyList())
      assertTrue(accepted)
      val row = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Queued, row.status)
      assertFalse(chat.healthOk.value)
      assertTrue(gateway.sentMessages.isEmpty())

      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("survives direct drop"), gateway.sentMessages)
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun directDispatchWaitsForStartupRecoveryBeforeClaimingItsRow() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val recoveryGate = CompletableDeferred<Unit>()
      outbox.recoveryGate = recoveryGate
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      runCurrent()
      chat.setThinkingLevel("off")

      chat.sendMessage(message = "waits for recovery", thinkingLevel = "off", attachments = emptyList())
      runCurrent()
      try {
        // The row is journaled but must not be claimed 'sending' while the unscoped recovery
        // sweep is pending, or the sweep would park this live dispatch as unconfirmed.
        assertTrue(gateway.sentMessages.isEmpty())
        val row = outbox.rows.values.single()
        assertEquals(ChatOutboxStatus.Queued, row.status)
      } finally {
        recoveryGate.complete(Unit)
      }
      advanceUntilIdle()
      assertEquals(listOf("waits for recovery"), gateway.sentMessages)
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun ambiguousDirectSendKeepsTheComposerClearBecauseTheRowOwnsTheInput() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      gateway.sendFailureAfterDispatch = IllegalStateException("transport wedged")
      val accepted = chat.sendMessageAwaitAcceptance(message = "kept by the row", thinkingLevel = "off", attachments = emptyList())

      // The dispatch outcome is unknown, so the journaled row parks for review and owns the
      // input; a false return would restore a duplicate draft into the composer.
      assertTrue(accepted)
      val parked = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Failed, parked.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, parked.lastError)
      assertEquals(1, gateway.sentMessages.size)
    }

  @Test
  fun historyProofOnABlockedHeadReleasesItsQueuedSuccessorInTheSameFlush() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "head",
          sessionKey = "main",
          text = "delivered before restart",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Accepted,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "tail",
          sessionKey = "main",
          text = "blocked successor",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      // Canonical history already carries the head's turn from the previous process.
      gateway.historyMessagesJson =
        """[{"role":"user","content":"delivered before restart","timestamp":5,"idempotencyKey":"head:user"},""" +
        """{"role":"assistant","content":"r","timestamp":6,"idempotencyKey":"head:assistant"}]"""
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // Confirming the head must restart the drain so the released successor actually sends.
      assertEquals(listOf("blocked successor"), gateway.sentMessages)
      assertFalse(outbox.rows.containsKey("head"))
      assertFalse(outbox.rows.containsKey("tail"))
    }

  @Test
  fun retryingAnUnconfirmedHeadWhileOfflineKeepsItAheadOfQueuedSuccessors() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "head",
          sessionKey = "main",
          text = "ambiguous head",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Failed,
          retryCount = 0,
          lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "tail",
          sessionKey = "main",
          text = "younger successor",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      // Retry while still offline: the head re-queues ahead of its still-queued successor, so
      // the reconnect flush cannot deliver younger turns before the turn the user retried.
      chat.retryOutboxCommand("head")
      advanceUntilIdle()
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("ambiguous head", "younger successor"), gateway.sentMessages)
      assertTrue(outbox.rows.isEmpty())
    }
}
