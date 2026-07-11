package ai.openclaw.app.chat

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.room.withTransaction
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.UUID

/** Upper bound of cached session rows per gateway; oldest list positions are evicted on write. */
internal const val MAX_CACHED_SESSIONS = 50

internal const val CHAT_TRANSCRIPT_CACHE_DB_NAME = "chat-transcript-cache.db"

/** Upper bound of cached transcript rows per session; only the newest messages are kept. */
internal const val MAX_CACHED_MESSAGES_PER_SESSION = 200

/**
 * Read-only offline cache of chat sessions and transcripts.
 *
 * The cache is disposable: it only speeds up cold open and enables offline browsing.
 * Live responses replace cached data; the active deep session may be retained outside the newest
 * session-list window so its transcript remains available offline.
 */
interface ChatTranscriptCache {
  suspend fun loadSessions(gatewayId: String): List<ChatSessionEntry>

  suspend fun loadTranscript(
    gatewayId: String,
    sessionKey: String,
  ): List<ChatMessage>

  suspend fun saveSessions(
    gatewayId: String,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String? = null,
  )

  suspend fun saveTranscript(
    gatewayId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  )

  /** Removes one session and its transcript, so gateway-side deletes also purge offline copies. */
  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  )

  /** Removes every cached transcript row owned by one gateway identity. */
  suspend fun clearGateway(gatewayId: String)
}

@Entity(tableName = "cached_sessions", primaryKeys = ["gatewayId", "sessionKey"])
internal data class CachedSessionEntity(
  val gatewayId: String,
  val sessionKey: String,
  val displayName: String?,
  val updatedAtMs: Long?,
  // Preserves gateway list order so offline session rows render in the familiar order.
  val rowOrder: Int,
)

@Entity(tableName = "cached_messages", primaryKeys = ["gatewayId", "sessionKey", "rowOrder"])
internal data class CachedMessageEntity(
  val gatewayId: String,
  val sessionKey: String,
  val rowOrder: Int,
  val role: String,
  // JSON array of text part strings; attachments/binary parts are never persisted.
  val textPartsJson: String,
  val timestampMs: Long?,
  // Kept so live history reconciliation can match cached rows by identity key.
  val idempotencyKey: String?,
)

@Dao
internal interface ChatCacheDao {
  @Query("SELECT * FROM cached_sessions WHERE gatewayId = :gatewayId ORDER BY rowOrder ASC")
  suspend fun sessions(gatewayId: String): List<CachedSessionEntity>

  @Query("SELECT * FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun session(
    gatewayId: String,
    sessionKey: String,
  ): CachedSessionEntity?

  @Query(
    "SELECT * FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey ORDER BY rowOrder ASC",
  )
  suspend fun messages(
    gatewayId: String,
    sessionKey: String,
  ): List<CachedMessageEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertSessions(rows: List<CachedSessionEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertSessionStub(row: CachedSessionEntity)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertMessages(rows: List<CachedMessageEntity>)

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId")
  suspend fun deleteSessions(gatewayId: String)

  @Query("DELETE FROM cached_messages WHERE gatewayId = :gatewayId")
  suspend fun deleteMessages(gatewayId: String)

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteSessionRow(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteTranscript(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("SELECT COALESCE(MAX(rowOrder), -1) + 1 FROM cached_sessions WHERE gatewayId = :gatewayId")
  suspend fun nextSessionRowOrder(gatewayId: String): Int

  // Keeps the just-written session even when the cache is full: without the exclusion, a stub
  // inserted at the highest rowOrder would be evicted immediately and deep-session transcripts
  // could never be cached once MAX_CACHED_SESSIONS rows exist.
  @Query(
    "DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey != :keepSessionKey AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId AND sessionKey != :keepSessionKey " +
      "ORDER BY rowOrder ASC LIMIT :keep)",
  )
  suspend fun evictSessionsBeyondKeeping(
    gatewayId: String,
    keepSessionKey: String,
    keep: Int,
  )

  // Transcripts must never outlive their session row; this keeps total cache size bounded
  // by MAX_CACHED_SESSIONS * MAX_CACHED_MESSAGES_PER_SESSION rows per gateway.
  @Query(
    "DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId)",
  )
  suspend fun evictOrphanedTranscripts(gatewayId: String)
}

@Database(
  entities = [
    CachedSessionEntity::class,
    CachedMessageEntity::class,
    OutboxCommandEntity::class,
    OutboxAttachmentEntity::class,
    OutboxAttachmentChunkEntity::class,
  ],
  version = 4,
  exportSchema = false,
)
internal abstract class ChatCacheDatabase : RoomDatabase() {
  abstract fun dao(): ChatCacheDao

  abstract fun outboxDao(): ChatOutboxDao

  companion object {
    internal val MIGRATION_2_3 =
      object : Migration(2, 3) {
        override fun migrate(db: SupportSQLiteDatabase) {
          // v2 persisted every post-dispatch exception as queued+lastError. Those rows may
          // already have run, so upgrading must park them alongside crash-interrupted sends.
          db.execSQL(
            "UPDATE outbox_commands SET status = ?, lastError = ? " +
              "WHERE status = ? OR (status = ? AND lastError IS NOT NULL)",
            arrayOf<Any?>(
              ChatOutboxStatus.Failed.dbValue,
              OUTBOX_DELIVERY_UNCONFIRMED_ERROR,
              ChatOutboxStatus.Sending.dbValue,
              ChatOutboxStatus.Queued.dbValue,
            ),
          )
        }
      }

    internal val MIGRATION_3_4 =
      object : Migration(3, 4) {
        override fun migrate(db: SupportSQLiteDatabase) {
          db.execSQL("ALTER TABLE `outbox_commands` ADD COLUMN `gatedEpoch` INTEGER")
          // Legacy queued command-shaped rows predate connection epochs; the sentinel makes
          // them park for explicit retry instead of silently replaying on the next reconnect.
          db.execSQL(
            "UPDATE outbox_commands SET gatedEpoch = ? WHERE status = ? AND text LIKE '/%'",
            arrayOf<Any?>(OUTBOX_GATED_EPOCH_NEVER, ChatOutboxStatus.Queued.dbValue),
          )
          db.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox_attachments` (`id` TEXT NOT NULL, `commandId` TEXT NOT NULL, " +
              "`position` INTEGER NOT NULL, `type` TEXT NOT NULL, `mimeType` TEXT NOT NULL, `fileName` TEXT NOT NULL, " +
              "`durationMs` INTEGER, `byteLength` INTEGER NOT NULL, PRIMARY KEY(`id`))",
          )
          db.execSQL("CREATE INDEX IF NOT EXISTS `index_outbox_attachments_commandId` ON `outbox_attachments` (`commandId`)")
          db.execSQL(
            "CREATE TABLE IF NOT EXISTS `outbox_attachment_chunks` (`attachmentId` TEXT NOT NULL, " +
              "`chunkIndex` INTEGER NOT NULL, `bytes` BLOB NOT NULL, PRIMARY KEY(`attachmentId`, `chunkIndex`))",
          )
        }
      }

    fun open(
      context: Context,
      name: String = CHAT_TRANSCRIPT_CACHE_DB_NAME,
    ): ChatCacheDatabase =
      Room
        .databaseBuilder(context, ChatCacheDatabase::class.java, name)
        .addMigrations(MIGRATION_2_3, MIGRATION_3_4)
        // v1 has only disposable transcripts. Starting with v2, the outbox is user data, so every
        // supported bump needs an explicit migration; destructive fallback remains for v1 only.
        .fallbackToDestructiveMigrationFrom(true, 1)
        .build()
  }
}

/**
 * Room-backed [ChatTranscriptCache]. Callers bind every operation to the gateway scope captured
 * before their suspend point, so a connection switch cannot re-scope an old response.
 */
class RoomChatTranscriptCache internal constructor(
  private val database: ChatCacheDatabase,
) : ChatTranscriptCache {
  private val json = Json
  private val textPartsSerializer = ListSerializer(String.serializer())

  override suspend fun loadSessions(gatewayId: String): List<ChatSessionEntry> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    return database.dao().sessions(gateway).map { row ->
      ChatSessionEntry(
        key = row.sessionKey,
        updatedAtMs = row.updatedAtMs,
        displayName = row.displayName,
      )
    }
  }

  override suspend fun loadTranscript(
    gatewayId: String,
    sessionKey: String,
  ): List<ChatMessage> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return emptyList()
    return database.dao().messages(gateway, key).mapNotNull { row ->
      val role = normalizeVisibleChatMessageRole(row.role) ?: return@mapNotNull null
      ChatMessage(
        id = UUID.randomUUID().toString(),
        role = role,
        content = decodeTextParts(row.textPartsJson).map { ChatMessageContent(type = "text", text = it) },
        timestampMs = row.timestampMs,
        idempotencyKey = row.idempotencyKey,
      )
    }
  }

  override suspend fun saveSessions(
    gatewayId: String,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String?,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val retainedKey = retainedSessionKey?.trim()?.takeIf { it.isNotEmpty() }
    val dao = database.dao()
    database.withTransaction {
      val initialSessions = sessions.take(MAX_CACHED_SESSIONS)
      val needsRetainedRow = retainedKey != null && initialSessions.none { it.key == retainedKey }
      val retainedEntry = if (needsRetainedRow) sessions.firstOrNull { it.key == retainedKey } else null
      val retainedRow =
        if (needsRetainedRow) {
          retainedEntry?.let { entry ->
            CachedSessionEntity(
              gatewayId = gateway,
              sessionKey = entry.key,
              displayName = entry.displayName,
              updatedAtMs = entry.updatedAtMs,
              rowOrder = 0,
            )
          } ?: dao.session(gateway, retainedKey)
        } else {
          null
        }
      val listedSessionLimit = MAX_CACHED_SESSIONS - if (retainedRow == null) 0 else 1
      val rows =
        sessions.take(listedSessionLimit).mapIndexed { index, session ->
          CachedSessionEntity(
            gatewayId = gateway,
            sessionKey = session.key,
            displayName = session.displayName,
            updatedAtMs = session.updatedAtMs,
            rowOrder = index,
          )
        }
      dao.deleteSessions(gateway)
      dao.insertSessions(rows)
      retainedRow?.let { dao.insertSessions(listOf(it.copy(rowOrder = rows.size))) }
      dao.evictOrphanedTranscripts(gateway)
    }
  }

  override suspend fun saveTranscript(
    gatewayId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    // Text rows only: attachment/binary parts are dropped, and messages without any text are skipped.
    val rows =
      messages
        .mapNotNull { message ->
          val role = normalizeVisibleChatMessageRole(message.role) ?: return@mapNotNull null
          val textParts = message.content.filter { it.type == "text" }.mapNotNull { it.text }
          if (textParts.isEmpty()) return@mapNotNull null
          Triple(message, role, textParts)
        }.takeLast(MAX_CACHED_MESSAGES_PER_SESSION)
        .mapIndexed { index, (message, role, textParts) ->
          CachedMessageEntity(
            gatewayId = gateway,
            sessionKey = key,
            rowOrder = index,
            role = role,
            textPartsJson = json.encodeToString(textPartsSerializer, textParts),
            timestampMs = message.timestampMs,
            idempotencyKey = message.idempotencyKey,
          )
        }
    val dao = database.dao()
    database.withTransaction {
      dao.deleteTranscript(gateway, key)
      dao.insertMessages(rows)
      // A transcript may arrive for a session missing from the cached list (e.g. deep session
      // switch); keep a stub row so the transcript stays reachable, then re-apply the bounds.
      dao.insertSessionStub(
        CachedSessionEntity(
          gatewayId = gateway,
          sessionKey = key,
          displayName = null,
          updatedAtMs = null,
          rowOrder = dao.nextSessionRowOrder(gateway),
        ),
      )
      dao.evictSessionsBeyondKeeping(gateway, keepSessionKey = key, keep = MAX_CACHED_SESSIONS - 1)
      dao.evictOrphanedTranscripts(gateway)
    }
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val dao = database.dao()
    database.withTransaction {
      dao.deleteMessages(gateway)
      dao.deleteSessions(gateway)
    }
  }

  override suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    val dao = database.dao()
    database.withTransaction {
      dao.deleteSessionRow(gateway, key)
      dao.deleteTranscript(gateway, key)
    }
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }

  private fun decodeTextParts(encoded: String): List<String> = runCatching { json.decodeFromString(textPartsSerializer, encoded) }.getOrDefault(emptyList())
}
