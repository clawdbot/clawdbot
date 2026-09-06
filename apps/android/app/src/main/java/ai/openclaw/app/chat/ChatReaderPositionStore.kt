package ai.openclaw.app.chat

import androidx.room3.withWriteTransaction
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal const val MAX_READER_POSITION_MESSAGE_VERSION_CHARS = 4_096
private const val MAX_METADATA_CHARS = 256 * 1_024

internal fun chatReaderPositionMetadataKey(gatewayId: String): String = "chat-reader-positions-v1:$gatewayId"

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
) {
  internal val logicalKey get() = Triple(gatewayId, ownerAgentId, sessionKey)
}

// Object identity is the write lease: rebinding the same key invalidates the old viewport.
internal class ChatReaderPositionBinding(
  val scope: ChatReaderPositionScope,
  val position: ChatReaderPosition?,
)

@Serializable
private data class SavedReaderPosition(
  val ownerAgentId: String,
  val sessionKey: String,
  val sessionId: String,
  val messageId: String,
  val itemOffset: Int,
  val messageVersion: String? = null,
  val entryId: String? = null,
) {
  val position get() = ChatReaderPosition(messageId, itemOffset, messageVersion, entryId)

  fun matches(scope: ChatReaderPositionScope): Boolean = ownerAgentId == scope.ownerAgentId && sessionKey == scope.sessionKey

  fun isValid(): Boolean =
    ownerAgentId.length in 1..256 && sessionKey.length in 1..512 && sessionId.length in 1..512 &&
      messageId.length in 1..512 && itemOffset >= 0 && (entryId?.length ?: 0) <= 512 &&
      (messageVersion?.length ?: 0) <= MAX_READER_POSITION_MESSAGE_VERSION_CHARS
}

@Serializable
private data class ReaderPositionMetadata(
  val version: Int = 1,
  val positions: List<SavedReaderPosition> = emptyList(),
)

/** One store per opened client database, shared by UI saves and gateway cleanup. */
internal class ChatReaderPositionStore(
  private val database: ClientStateDatabase,
) {
  private val mutex = Mutex()
  private val bindings = mutableMapOf<Triple<String, String, String>, ChatReaderPositionBinding>()
  private val retiredGateways = mutableSetOf<String>()
  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }

  suspend fun activateGateway(
    gatewayId: String,
    isCurrent: () -> Boolean,
  ): Boolean =
    mutex.withLock {
      if (!isCurrent()) return@withLock false
      retiredGateways.remove(gatewayId)
      true
    }

  suspend fun bind(scope: ChatReaderPositionScope): ChatReaderPositionBinding? =
    mutex.withLock {
      if (scope.gatewayId in retiredGateways) return@withLock null
      val saved = read(scope.gatewayId).lastOrNull { it.matches(scope) && it.sessionId == scope.sessionId }
      ChatReaderPositionBinding(scope, saved?.position).also { bindings[scope.logicalKey] = it }
    }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    position: ChatReaderPosition?,
  ) = mutex.withLock {
    val scope = binding.scope
    if (bindings[scope.logicalKey] !== binding) return@withLock
    val saved =
      position?.let {
        SavedReaderPosition(scope.ownerAgentId, scope.sessionKey, scope.sessionId, it.messageId, it.itemOffset, it.messageVersion, it.entryId)
      }
    if (saved != null && !saved.isValid()) return@withLock
    mutate(scope.gatewayId) { positions ->
      positions.removeAll { it.matches(scope) }
      saved?.let(positions::add)
    }
  }

  suspend fun deleteSession(scope: ChatReaderPositionScope) =
    mutex.withLock {
      if (bindings[scope.logicalKey]?.scope?.sessionId == scope.sessionId) bindings.remove(scope.logicalKey)
      mutate(scope.gatewayId) { positions -> positions.removeAll { it.matches(scope) && it.sessionId == scope.sessionId } }
    }

  suspend fun clearGateway(
    gatewayId: String,
    clear: suspend () -> Unit,
  ) = mutex.withLock {
    retiredGateways.add(gatewayId)
    bindings.keys.removeAll { it.first == gatewayId }
    // The caller clears bookmarks and other gateway state in the same Room transaction.
    // Hold this lock through the commit so a queued save cannot resurrect removed state.
    clear()
  }

  private suspend fun read(gatewayId: String): MutableList<SavedReaderPosition> {
    val raw = database.controlDao().metadataValue(chatReaderPositionMetadataKey(gatewayId)) ?: return mutableListOf()
    if (raw.length > MAX_METADATA_CHARS) return mutableListOf()
    val stored = runCatching { json.decodeFromString<ReaderPositionMetadata>(raw) }.getOrNull()
    if (stored?.version != 1) return mutableListOf()
    return stored.positions
      .takeLast(MAX_CACHED_SESSIONS)
      .filter { it.isValid() }
      .toMutableList()
  }

  private suspend fun mutate(
    gatewayId: String,
    change: (MutableList<SavedReaderPosition>) -> Unit,
  ) {
    database.withWriteTransaction {
      val positions = read(gatewayId)
      change(positions)
      while (positions.size > MAX_CACHED_SESSIONS) positions.removeAt(0)
      var encoded = json.encodeToString(ReaderPositionMetadata(positions = positions))
      while (encoded.length > MAX_METADATA_CHARS && positions.isNotEmpty()) {
        positions.removeAt(0)
        encoded = json.encodeToString(ReaderPositionMetadata(positions = positions))
      }
      val key = chatReaderPositionMetadataKey(gatewayId)
      if (positions.isEmpty()) {
        database.controlDao().deleteMetadata(key)
      } else {
        database.controlDao().upsertMetadata(ClientStateMetadataEntity(key, encoded))
      }
    }
  }
}
