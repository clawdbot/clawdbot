package ai.openclaw.app.chat

import androidx.room3.Dao
import androidx.room3.Entity
import androidx.room3.Insert
import androidx.room3.OnConflictStrategy
import androidx.room3.Query
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
  private var nextGeneration = 0L

  suspend fun <T> bind(
    gatewayId: String,
    sessionKey: String,
    load: suspend () -> T,
  ): Pair<Long, T> =
    mutex.withLock {
      val value = load()
      val generation = ++nextGeneration
      generations[Key(gatewayId, sessionKey)] = generation
      generation to value
    }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    write: suspend () -> Unit,
  ) = mutex.withLock {
    if (generations[Key(binding.gatewayId, binding.sessionKey)] == binding.generation) write()
  }

  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
    delete: suspend () -> Unit,
  ) = mutex.withLock {
    // Invalidate before deletion so work queued from the retired UI generation cannot
    // recreate the row after this owner releases the mutex.
    generations.remove(Key(gatewayId, sessionKey))
    delete()
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
    val (generation, position) =
      fence.bind(gatewayId, sessionKey) {
        database()
          .readerPositionDao()
          .load(gatewayId, sessionKey)
          ?.let { ChatReaderPosition(it.messageId, it.itemOffset, it.messageVersion) }
      }
    return ChatReaderPositionBinding(gatewayId, sessionKey, position, generation)
  }

  suspend fun save(
    binding: ChatReaderPositionBinding,
    position: ChatReaderPosition,
  ) = fence.save(binding) {
    database()
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

  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  ) = fence.deleteSession(gatewayId, sessionKey) { database().readerPositionDao().deleteSession(gatewayId, sessionKey) }

  suspend fun <T> clearGateway(
    gatewayId: String,
    clear: suspend (ClientStateDatabase) -> T,
  ): T = fence.clearGateway(gatewayId) { clear(database()) }
}
