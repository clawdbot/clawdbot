package ai.openclaw.app.chat

import androidx.room3.withWriteTransaction
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

private const val READER_POSITION_METADATA_PREFIX = "chat-reader-positions-v1:"
private const val READER_POSITION_METADATA_VERSION = 1
private const val MAX_READER_POSITION_OWNER_AGENT_ID_CHARS = 256
private const val MAX_READER_POSITION_SESSION_KEY_CHARS = 512
private const val MAX_READER_POSITION_SESSION_ID_CHARS = 512
private const val MAX_READER_POSITION_MESSAGE_ID_CHARS = 512
private const val MAX_READER_POSITION_ENTRY_ID_CHARS = 512
internal const val MAX_READER_POSITION_MESSAGE_VERSION_CHARS = 4_096
private const val MAX_READER_POSITION_METADATA_CHARS = 256 * 1_024
private const val RETIRED_READER_POSITION_GENERATION = 0L

// The persisted LRU follows the same recent-session bound as the offline transcript cache.
// This keeps one gateway metadata row bounded while retaining every locally cached chat.
private const val MAX_READER_POSITIONS_PER_GATEWAY = MAX_CACHED_SESSIONS

internal fun chatReaderPositionMetadataKey(gatewayId: String): String = "$READER_POSITION_METADATA_PREFIX$gatewayId"

internal data class ChatReaderPosition(
  val messageId: String,
  val itemOffset: Int,
  val messageVersion: String? = null,
  val entryId: String? = null,
)

internal data class ChatReaderPositionScope(
  val gatewayId: String,
  val ownerAgentId: String,
  val sessionKey: String,
  val sessionId: String,
)

internal data class ChatReaderPositionBinding(
  val scope: ChatReaderPositionScope,
  val position: ChatReaderPosition?,
  internal val generation: Long,
)

private data class StoredReaderPositionKey(
  val ownerAgentId: String,
  val sessionKey: String,
)

private data class StoredReaderPosition(
  val sessionId: String,
  val position: ChatReaderPosition,
)

internal sealed interface ChatReaderPositionRetirement {
  val scope: ChatReaderPositionScope
  val completion: CompletableDeferred<Unit>

  data class Owner(
    override val scope: ChatReaderPositionScope,
    override val completion: CompletableDeferred<Unit>,
  ) : ChatReaderPositionRetirement

  data class Waiting(
    override val scope: ChatReaderPositionScope,
    override val completion: CompletableDeferred<Unit>,
  ) : ChatReaderPositionRetirement
}

private fun decodeReaderPositions(raw: String?): LinkedHashMap<StoredReaderPositionKey, StoredReaderPosition> {
  if (raw == null || raw.length > MAX_READER_POSITION_METADATA_CHARS) return linkedMapOf()
  val root = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return linkedMapOf()
  if ((root["version"] as? JsonPrimitive)?.intOrNull != READER_POSITION_METADATA_VERSION) return linkedMapOf()
  val entries = root["positions"] as? JsonArray ?: return linkedMapOf()
  val positions = linkedMapOf<StoredReaderPositionKey, StoredReaderPosition>()
  for (entry in entries.takeLast(MAX_READER_POSITIONS_PER_GATEWAY)) {
    val value = entry as? JsonObject ?: continue
    val ownerAgentId = (value["ownerAgentId"] as? JsonPrimitive)?.contentOrNull ?: continue
    val sessionKey = (value["sessionKey"] as? JsonPrimitive)?.contentOrNull ?: continue
    val sessionId = (value["sessionId"] as? JsonPrimitive)?.contentOrNull ?: continue
    val messageId = (value["messageId"] as? JsonPrimitive)?.contentOrNull ?: continue
    val itemOffset = (value["itemOffset"] as? JsonPrimitive)?.intOrNull ?: continue
    val messageVersion = (value["messageVersion"] as? JsonPrimitive)?.contentOrNull
    val entryId = (value["entryId"] as? JsonPrimitive)?.contentOrNull
    if (
      ownerAgentId.isEmpty() || ownerAgentId.length > MAX_READER_POSITION_OWNER_AGENT_ID_CHARS ||
      sessionKey.isEmpty() || sessionKey.length > MAX_READER_POSITION_SESSION_KEY_CHARS ||
      sessionId.isEmpty() || sessionId.length > MAX_READER_POSITION_SESSION_ID_CHARS ||
      messageId.isEmpty() || messageId.length > MAX_READER_POSITION_MESSAGE_ID_CHARS ||
      (entryId?.length ?: 0) > MAX_READER_POSITION_ENTRY_ID_CHARS ||
      itemOffset < 0 ||
      (messageVersion?.length ?: 0) > MAX_READER_POSITION_MESSAGE_VERSION_CHARS
    ) {
      continue
    }
    val key = StoredReaderPositionKey(ownerAgentId, sessionKey)
    positions.remove(key)
    positions[key] = StoredReaderPosition(sessionId, ChatReaderPosition(messageId, itemOffset, messageVersion, entryId))
  }
  return positions
}

private fun encodeReaderPositions(positions: Map<StoredReaderPositionKey, StoredReaderPosition>): String =
  buildJsonObject {
    put("version", JsonPrimitive(READER_POSITION_METADATA_VERSION))
    put(
      "positions",
      buildJsonArray {
        positions.forEach { (key, stored) ->
          add(
            buildJsonObject {
              put("ownerAgentId", JsonPrimitive(key.ownerAgentId))
              put("sessionKey", JsonPrimitive(key.sessionKey))
              put("sessionId", JsonPrimitive(stored.sessionId))
              val position = stored.position
              put("messageId", JsonPrimitive(position.messageId))
              put("itemOffset", JsonPrimitive(position.itemOffset))
              position.messageVersion?.let { put("messageVersion", JsonPrimitive(it)) }
              position.entryId?.let { put("entryId", JsonPrimitive(it)) }
            },
          )
        }
      },
    )
  }.toString()

private fun ChatReaderPosition.isPersistable(scope: ChatReaderPositionScope): Boolean =
  scope.ownerAgentId.isNotEmpty() &&
    scope.ownerAgentId.length <= MAX_READER_POSITION_OWNER_AGENT_ID_CHARS &&
    scope.sessionKey.isNotEmpty() &&
    scope.sessionKey.length <= MAX_READER_POSITION_SESSION_KEY_CHARS &&
    scope.sessionId.isNotEmpty() &&
    scope.sessionId.length <= MAX_READER_POSITION_SESSION_ID_CHARS &&
    messageId.isNotEmpty() &&
    messageId.length <= MAX_READER_POSITION_MESSAGE_ID_CHARS &&
    (entryId?.length ?: 0) <= MAX_READER_POSITION_ENTRY_ID_CHARS &&
    itemOffset >= 0 &&
    (messageVersion?.length ?: 0) <= MAX_READER_POSITION_MESSAGE_VERSION_CHARS

/** Serializes every reader-position write and retirement across facades for this database. */
internal class ChatReaderPositionFence {
  private data class LogicalKey(
    val gatewayId: String,
    val ownerAgentId: String,
    val sessionKey: String,
  )

  private data class ActiveGeneration(
    val sessionId: String,
    val generation: Long,
  )

  private val mutex = Mutex()
  private val generations = mutableMapOf<LogicalKey, ActiveGeneration>()
  private val retirements = mutableMapOf<ChatReaderPositionScope, CompletableDeferred<Unit>>()
  private val retiredGateways = mutableSetOf<String>()
  private var nextGeneration = 0L

  private sealed interface BindResult {
    data class Ready(
      val generation: Long,
    ) : BindResult

    data class Waiting(
      val retirement: CompletableDeferred<Unit>,
    ) : BindResult

    data object Retired : BindResult
  }

  suspend fun activateGateway(
    gatewayId: String,
    isCurrent: () -> Boolean = { true },
  ): Boolean =
    mutex.withLock {
      if (!isCurrent()) return@withLock false
      retiredGateways.remove(gatewayId)
      true
    }

  suspend fun bind(
    scope: ChatReaderPositionScope,
  ): Long {
    while (true) {
      when (
        val result =
          mutex.withLock {
            retirements[scope]?.let { BindResult.Waiting(it) }
              ?: if (scope.gatewayId in retiredGateways) {
                BindResult.Retired
              } else {
                BindResult.Ready(++nextGeneration).also {
                  generations[scope.logicalKey()] = ActiveGeneration(scope.sessionId, it.generation)
                }
              }
          }
      ) {
        is BindResult.Ready -> return result.generation
        is BindResult.Waiting -> result.retirement.await()
        BindResult.Retired -> return RETIRED_READER_POSITION_GENERATION
      }
    }
  }

  suspend fun <T> load(
    scope: ChatReaderPositionScope,
    generation: Long,
    read: suspend () -> T,
  ): T? =
    mutex.withLock {
      if (generations[scope.logicalKey()] != ActiveGeneration(scope.sessionId, generation)) return@withLock null
      read()
    }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    write: suspend () -> Unit,
  ) = mutex.withLock {
    val scope = binding.scope
    if (generations[scope.logicalKey()] == ActiveGeneration(scope.sessionId, binding.generation)) write()
  }

  suspend fun retireSession(scope: ChatReaderPositionScope): ChatReaderPositionRetirement =
    mutex.withLock {
      retirements[scope]?.let { return@withLock ChatReaderPositionRetirement.Waiting(scope, it) }
      val key = scope.logicalKey()
      if (generations[key]?.sessionId == scope.sessionId) generations.remove(key)
      val completion = CompletableDeferred<Unit>()
      retirements[scope] = completion
      ChatReaderPositionRetirement.Owner(scope, completion)
    }

  suspend fun deleteSession(
    retirement: ChatReaderPositionRetirement.Owner,
    delete: suspend () -> Unit,
  ) = mutex.withLock {
    try {
      delete()
    } finally {
      completeRetirement(retirement.scope, retirement.completion)
    }
  }

  suspend fun releaseRetirement(
    retirement: ChatReaderPositionRetirement.Owner,
  ) = mutex.withLock {
    completeRetirement(retirement.scope, retirement.completion)
  }

  private fun completeRetirement(
    scope: ChatReaderPositionScope,
    retirement: CompletableDeferred<Unit>,
  ) {
    if (retirements[scope] !== retirement) return
    retirements.remove(scope)
    retirement.complete(Unit)
  }

  suspend fun <T> clearGateway(
    gatewayId: String,
    clear: suspend () -> T,
  ): T =
    mutex.withLock {
      // Activation, retirement, and binding share one order; no concurrent marker can be lost.
      retiredGateways.add(gatewayId)
      generations.keys.removeAll { it.gatewayId == gatewayId }
      clear()
    }

  private fun ChatReaderPositionScope.logicalKey() = LogicalKey(gatewayId, ownerAgentId, sessionKey)
}

internal class ChatReaderPositionStore(
  private val database: suspend () -> ClientStateDatabase,
  private val fence: ChatReaderPositionFence = ChatReaderPositionFence(),
) {
  suspend fun activateGateway(
    gatewayId: String,
    isCurrent: () -> Boolean = { true },
  ): Boolean {
    // Startup recovery uses this fence too. Await it without the lock, then revalidate intent.
    database()
    return fence.activateGateway(gatewayId, isCurrent)
  }

  suspend fun bind(
    scope: ChatReaderPositionScope,
  ): ChatReaderPositionBinding {
    // Reserve the UI generation before database readiness. Startup recovery can then
    // invalidate it without waiting behind a bind that is awaiting initialization.
    val generation = fence.bind(scope)
    val state = database()
    val position =
      fence.load(scope, generation) {
        val stored =
          decodeReaderPositions(state.controlDao().metadataValue(chatReaderPositionMetadataKey(scope.gatewayId)))[
            StoredReaderPositionKey(scope.ownerAgentId, scope.sessionKey),
          ]
        stored?.position?.takeIf { stored.sessionId == scope.sessionId }
      }
    return ChatReaderPositionBinding(scope, position, generation)
  }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    position: ChatReaderPosition,
  ) {
    val state = database()
    fence.save(binding) {
      val scope = binding.scope
      mutatePositions(state, scope.gatewayId) { positions ->
        val key = StoredReaderPositionKey(scope.ownerAgentId, scope.sessionKey)
        positions.remove(key)
        if (position.isPersistable(scope)) positions[key] = StoredReaderPosition(scope.sessionId, position)
        while (positions.size > MAX_READER_POSITIONS_PER_GATEWAY) {
          positions.remove(positions.keys.first())
        }
      }
    }
  }

  suspend fun clear(binding: ChatReaderPositionBinding) {
    val state = database()
    fence.save(binding) {
      val scope = binding.scope
      mutatePositions(state, scope.gatewayId) { positions ->
        val key = StoredReaderPositionKey(scope.ownerAgentId, scope.sessionKey)
        positions.remove(key)
      }
    }
  }

  suspend fun deleteSession(scope: ChatReaderPositionScope) {
    val retirement = fence.retireSession(scope)
    if (retirement is ChatReaderPositionRetirement.Waiting) {
      retirement.completion.await()
      return
    }
    check(retirement is ChatReaderPositionRetirement.Owner)
    try {
      val state = database()
      fence.deleteSession(retirement) {
        mutatePositions(state, scope.gatewayId) { positions ->
          val key = StoredReaderPositionKey(scope.ownerAgentId, scope.sessionKey)
          if (positions[key]?.sessionId == scope.sessionId) positions.remove(key)
        }
      }
    } catch (error: Throwable) {
      fence.releaseRetirement(retirement)
      throw error
    }
  }

  suspend fun <T> clearGateway(
    gatewayId: String,
    clear: suspend (ClientStateDatabase) -> T,
  ): T {
    val state = database()
    return fence.clearGateway(gatewayId) { clear(state) }
  }

  private suspend fun mutatePositions(
    state: ClientStateDatabase,
    gatewayId: String,
    mutate: (LinkedHashMap<StoredReaderPositionKey, StoredReaderPosition>) -> Unit,
  ) {
    state.withWriteTransaction {
      val control = state.controlDao()
      val key = chatReaderPositionMetadataKey(gatewayId)
      val positions = decodeReaderPositions(control.metadataValue(key))
      mutate(positions)
      if (positions.isEmpty()) {
        control.deleteMetadata(key)
      } else {
        var encoded = encodeReaderPositions(positions)
        while (encoded.length > MAX_READER_POSITION_METADATA_CHARS && positions.isNotEmpty()) {
          positions.remove(positions.keys.first())
          encoded = encodeReaderPositions(positions)
        }
        if (positions.isEmpty()) {
          control.deleteMetadata(key)
        } else {
          control.upsertMetadata(ClientStateMetadataEntity(key, encoded))
        }
      }
    }
  }
}
