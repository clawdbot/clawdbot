package ai.openclaw.app.chat

import androidx.room3.Dao
import androidx.room3.Entity
import androidx.room3.Insert
import androidx.room3.OnConflictStrategy
import androidx.room3.Query
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal data class ChatReaderPosition(
  val messageId: String,
  val itemOffset: Int,
  val messageVersion: String? = null,
)

internal data class ChatReaderPositionBinding(
  val gatewayId: String,
  val sessionKey: String,
  val position: ChatReaderPosition?,
  internal val generation: Long,
)

@Entity(tableName = "chat_reader_positions", primaryKeys = ["gatewayId", "sessionKey"])
internal data class ChatReaderPositionEntity(
  val gatewayId: String,
  val sessionKey: String,
  val messageId: String,
  val itemOffset: Int,
  val messageVersion: String?,
)

@Dao
internal interface ChatReaderPositionDao {
  @Query("SELECT * FROM chat_reader_positions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun load(
    gatewayId: String,
    sessionKey: String,
  ): ChatReaderPositionEntity?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsert(position: ChatReaderPositionEntity)

  @Query("DELETE FROM chat_reader_positions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM chat_reader_positions WHERE gatewayId = :gatewayId")
  suspend fun clearGateway(gatewayId: String)
}

/** Serializes every reader-position write and retirement across facades for this database. */
internal class ChatReaderPositionFence {
  private data class Key(
    val gatewayId: String,
    val sessionKey: String,
  )

  private val mutex = Mutex()
  private val generations = mutableMapOf<Key, Long>()
  private val retirements = mutableMapOf<Key, CompletableDeferred<Unit>>()
  private var nextGeneration = 0L

  private sealed interface BindResult {
    data class Ready(
      val generation: Long,
    ) : BindResult

    data class Waiting(
      val retirement: CompletableDeferred<Unit>,
    ) : BindResult
  }

  suspend fun bind(
    gatewayId: String,
    sessionKey: String,
  ): Long {
    val key = Key(gatewayId, sessionKey)
    while (true) {
      when (
        val result =
          mutex.withLock {
            retirements[key]?.let { BindResult.Waiting(it) }
              ?: BindResult.Ready(++nextGeneration).also { generations[key] = it.generation }
          }
      ) {
        is BindResult.Ready -> return result.generation
        is BindResult.Waiting -> result.retirement.await()
      }
    }
  }

  suspend fun <T> load(
    gatewayId: String,
    sessionKey: String,
    generation: Long,
    read: suspend () -> T,
  ): T? =
    mutex.withLock {
      if (generations[Key(gatewayId, sessionKey)] != generation) return@withLock null
      read()
    }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    write: suspend () -> Unit,
  ) = mutex.withLock {
    if (generations[Key(binding.gatewayId, binding.sessionKey)] == binding.generation) write()
  }

  suspend fun retireSession(
    gatewayId: String,
    sessionKey: String,
  ): CompletableDeferred<Unit> =
    mutex.withLock {
      val key = Key(gatewayId, sessionKey)
      generations.remove(key)
      retirements.getOrPut(key) { CompletableDeferred() }
    }

  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
    retirement: CompletableDeferred<Unit>,
    delete: suspend () -> Unit,
  ) = mutex.withLock {
    val key = Key(gatewayId, sessionKey)
    try {
      delete()
    } finally {
      completeRetirement(key, retirement)
    }
  }

  suspend fun releaseRetirement(
    gatewayId: String,
    sessionKey: String,
    retirement: CompletableDeferred<Unit>,
  ) = mutex.withLock {
    completeRetirement(Key(gatewayId, sessionKey), retirement)
  }

  private fun completeRetirement(
    key: Key,
    retirement: CompletableDeferred<Unit>,
  ) {
    if (retirements[key] !== retirement) return
    retirements.remove(key)
    retirement.complete(Unit)
  }

  suspend fun <T> clearGateway(
    gatewayId: String,
    clear: suspend () -> T,
  ): T =
    mutex.withLock {
      generations.keys.removeAll { it.gatewayId == gatewayId }
      clear()
    }
}

internal class ChatReaderPositionStore(
  private val database: suspend () -> ClientStateDatabase,
  private val fence: ChatReaderPositionFence = ChatReaderPositionFence(),
) {
  suspend fun bind(
    gatewayId: String,
    sessionKey: String,
  ): ChatReaderPositionBinding {
    // Reserve the UI generation before database readiness. Startup recovery can then
    // invalidate it without waiting behind a bind that is awaiting initialization.
    val generation = fence.bind(gatewayId, sessionKey)
    val state = database()
    val position =
      fence.load(gatewayId, sessionKey, generation) {
        state
          .readerPositionDao()
          .load(gatewayId, sessionKey)
          ?.let { ChatReaderPosition(it.messageId, it.itemOffset, it.messageVersion) }
      }
    return ChatReaderPositionBinding(gatewayId, sessionKey, position, generation)
  }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    position: ChatReaderPosition,
  ) {
    val state = database()
    fence.save(binding) {
      state
        .readerPositionDao()
        .upsert(
          ChatReaderPositionEntity(
            gatewayId = binding.gatewayId,
            sessionKey = binding.sessionKey,
            messageId = position.messageId,
            itemOffset = position.itemOffset,
            messageVersion = position.messageVersion,
          ),
        )
    }
  }

  suspend fun clear(binding: ChatReaderPositionBinding) {
    val state = database()
    fence.save(binding) {
      state.readerPositionDao().deleteSession(binding.gatewayId, binding.sessionKey)
    }
  }

  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  ) {
    val retirement = fence.retireSession(gatewayId, sessionKey)
    try {
      val state = database()
      fence.deleteSession(gatewayId, sessionKey, retirement) {
        state.readerPositionDao().deleteSession(gatewayId, sessionKey)
      }
    } catch (error: Throwable) {
      fence.releaseRetirement(gatewayId, sessionKey, retirement)
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
}
