package ai.openclaw.app.chat

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.withTransaction
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.UUID

/** Upper bound of cached session rows per gateway across every agent owner. */
internal const val MAX_CACHED_SESSIONS = 50

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
  suspend fun loadLastDefaultAgentId(gatewayId: String): String?

  suspend fun saveLastDefaultAgentId(
    gatewayId: String,
    agentId: String,
  )

  suspend fun loadSessions(
    gatewayId: String,
    agentId: String,
  ): List<ChatSessionEntry>

  suspend fun loadTranscript(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  ): List<ChatMessage>

  suspend fun saveSessions(
    gatewayId: String,
    agentId: String,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String? = null,
  )

  suspend fun saveTranscript(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  )

  /** Removes one session and its transcript, so gateway-side deletes also purge offline copies. */
  suspend fun deleteSession(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  )

  /** Removes every cached transcript row owned by one gateway identity. */
  suspend fun clearGateway(gatewayId: String)
}

@Entity(tableName = "cached_sessions", primaryKeys = ["gatewayId", "agentId", "sessionKey"])
internal data class CachedSessionEntity(
  val gatewayId: String,
  val agentId: String,
  val sessionKey: String,
  val displayName: String?,
  val updatedAtMs: Long?,
  // Preserves gateway list order so offline session rows render in the familiar order.
  val rowOrder: Int,
)

@Entity(tableName = "cached_messages", primaryKeys = ["gatewayId", "agentId", "sessionKey", "rowOrder"])
internal data class CachedMessageEntity(
  val gatewayId: String,
  val agentId: String,
  val sessionKey: String,
  val rowOrder: Int,
  val role: String,
  // JSON array of text part strings; attachments/binary parts are never persisted.
  val textPartsJson: String,
  val timestampMs: Long?,
  // Kept so live history reconciliation can match cached rows by identity key.
  val idempotencyKey: String?,
)

@Entity(tableName = "cached_gateway_owners", primaryKeys = ["gatewayId"])
internal data class CachedGatewayOwnerEntity(
  val gatewayId: String,
  val agentId: String,
)

@Dao
internal interface ChatCacheDao {
  @Query("SELECT agentId FROM cached_gateway_owners WHERE gatewayId = :gatewayId")
  suspend fun lastDefaultAgentId(gatewayId: String): String?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsertGatewayOwner(row: CachedGatewayOwnerEntity)

  @Query("DELETE FROM cached_gateway_owners WHERE gatewayId = :gatewayId")
  suspend fun deleteGatewayOwner(gatewayId: String)

  @Query("SELECT * FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId ORDER BY rowOrder ASC")
  suspend fun sessions(
    gatewayId: String,
    agentId: String,
  ): List<CachedSessionEntity>

  @Query("SELECT * FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId AND sessionKey = :sessionKey")
  suspend fun session(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  ): CachedSessionEntity?

  @Query(
    "SELECT * FROM cached_messages WHERE gatewayId = :gatewayId AND agentId = :agentId " +
      "AND sessionKey = :sessionKey ORDER BY rowOrder ASC",
  )
  suspend fun messages(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  ): List<CachedMessageEntity>

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertSessions(rows: List<CachedSessionEntity>)

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertMessages(rows: List<CachedMessageEntity>)

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId")
  suspend fun deleteSessions(
    gatewayId: String,
    agentId: String,
  )

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId")
  suspend fun deleteSessionsForGateway(gatewayId: String)

  @Query("DELETE FROM cached_messages WHERE gatewayId = :gatewayId")
  suspend fun deleteMessages(gatewayId: String)

  @Query("DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId AND sessionKey = :sessionKey")
  suspend fun deleteSessionRow(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND agentId = :agentId AND sessionKey = :sessionKey")
  suspend fun deleteTranscript(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  )

  @Query("SELECT COALESCE(MAX(rowOrder), -1) + 1 FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId")
  suspend fun nextSessionRowOrder(
    gatewayId: String,
    agentId: String,
  ): Int

  // Keeps the just-written session even when the cache is full: without the exclusion, a stub
  // inserted at the highest rowOrder would be evicted immediately and deep-session transcripts
  // could never be cached once MAX_CACHED_SESSIONS rows exist.
  @Query(
    "DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId " +
      "AND sessionKey != :keepSessionKey AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId AND sessionKey != :keepSessionKey " +
      "ORDER BY rowOrder ASC LIMIT :keep)",
  )
  suspend fun evictSessionsBeyondKeeping(
    gatewayId: String,
    agentId: String,
    keepSessionKey: String,
    keep: Int,
  )

  // Owner-local cleanup runs before the gateway-wide bound below; transcripts never outlive
  // their corresponding session row.
  @Query(
    "DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND agentId = :agentId AND sessionKey NOT IN " +
      "(SELECT sessionKey FROM cached_sessions WHERE gatewayId = :gatewayId AND agentId = :agentId)",
  )
  suspend fun evictOrphanedTranscripts(
    gatewayId: String,
    agentId: String,
  )

  // A gateway can expose many agent owners. Cap their aggregate cache by recent writes so
  // switching owners cannot grow the disposable session/transcript tables without bound.
  @Query(
    "DELETE FROM cached_sessions WHERE gatewayId = :gatewayId AND rowid NOT IN " +
      "(SELECT rowid FROM cached_sessions WHERE gatewayId = :gatewayId ORDER BY rowid DESC LIMIT :keep)",
  )
  suspend fun evictGatewaySessionsBeyond(
    gatewayId: String,
    keep: Int,
  )

  @Query(
    "DELETE FROM cached_messages WHERE gatewayId = :gatewayId AND NOT EXISTS " +
      "(SELECT 1 FROM cached_sessions WHERE cached_sessions.gatewayId = cached_messages.gatewayId " +
      "AND cached_sessions.agentId = cached_messages.agentId " +
      "AND cached_sessions.sessionKey = cached_messages.sessionKey)",
  )
  suspend fun evictGatewayOrphanedTranscripts(gatewayId: String)
}

/**
 * Room-backed [ChatTranscriptCache]. Callers bind every operation to the gateway scope captured
 * before their suspend point, so a connection switch cannot re-scope an old response.
 */
class RoomChatTranscriptCache internal constructor(
  private val database: GatewayCacheDatabase,
) : ChatTranscriptCache {
  private val json = Json
  private val textPartsSerializer = ListSerializer(String.serializer())

  override suspend fun loadLastDefaultAgentId(gatewayId: String): String? {
    val gateway = scopedGatewayId(gatewayId) ?: return null
    return database
      .dao()
      .lastDefaultAgentId(gateway)
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
  }

  override suspend fun saveLastDefaultAgentId(
    gatewayId: String,
    agentId: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val agent = scopedAgentId(agentId) ?: return
    database.dao().upsertGatewayOwner(CachedGatewayOwnerEntity(gatewayId = gateway, agentId = agent))
  }

  override suspend fun loadSessions(
    gatewayId: String,
    agentId: String,
  ): List<ChatSessionEntry> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    val agent = scopedAgentId(agentId) ?: return emptyList()
    return database.dao().sessions(gateway, agent).map { row ->
      ChatSessionEntry(
        key = row.sessionKey,
        updatedAtMs = row.updatedAtMs,
        ownerAgentId = agent,
        displayName = row.displayName,
      )
    }
  }

  override suspend fun loadTranscript(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  ): List<ChatMessage> {
    val gateway = scopedGatewayId(gatewayId) ?: return emptyList()
    val agent = scopedAgentId(agentId) ?: return emptyList()
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return emptyList()
    return database.dao().messages(gateway, agent, key).mapNotNull { row ->
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
    agentId: String,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String?,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val agent = scopedAgentId(agentId) ?: return
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
              agentId = agent,
              sessionKey = entry.key,
              displayName = entry.displayName,
              updatedAtMs = entry.updatedAtMs,
              rowOrder = 0,
            )
          } ?: dao.session(gateway, agent, retainedKey)
        } else {
          null
        }
      val listedSessionLimit = MAX_CACHED_SESSIONS - if (retainedRow == null) 0 else 1
      val rows =
        sessions.take(listedSessionLimit).mapIndexed { index, session ->
          CachedSessionEntity(
            gatewayId = gateway,
            agentId = agent,
            sessionKey = session.key,
            displayName = session.displayName,
            updatedAtMs = session.updatedAtMs,
            rowOrder = index,
          )
        }
      dao.deleteSessions(gateway, agent)
      dao.insertSessions(rows)
      retainedRow?.let { dao.insertSessions(listOf(it.copy(rowOrder = rows.size))) }
      dao.evictOrphanedTranscripts(gateway, agent)
      dao.evictGatewaySessionsBeyond(gateway, MAX_CACHED_SESSIONS)
      dao.evictGatewayOrphanedTranscripts(gateway)
    }
  }

  override suspend fun saveTranscript(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val agent = scopedAgentId(agentId) ?: return
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
            agentId = agent,
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
      dao.deleteTranscript(gateway, agent, key)
      dao.insertMessages(rows)
      // A transcript may arrive for a session missing from the cached list (e.g. deep session
      // switch); keep a stub row so the transcript stays reachable, then re-apply the bounds.
      val currentSession = dao.session(gateway, agent, key)
      // REPLACE refreshes SQLite rowid, making the transcript's session the most recent gateway
      // row while preserving list metadata when that session was already cached.
      dao.insertSessions(
        listOf(
          currentSession
            ?: CachedSessionEntity(
              gatewayId = gateway,
              agentId = agent,
              sessionKey = key,
              displayName = null,
              updatedAtMs = null,
              rowOrder = dao.nextSessionRowOrder(gateway, agent),
            ),
        ),
      )
      dao.evictSessionsBeyondKeeping(gateway, agent, keepSessionKey = key, keep = MAX_CACHED_SESSIONS - 1)
      dao.evictOrphanedTranscripts(gateway, agent)
      dao.evictGatewaySessionsBeyond(gateway, MAX_CACHED_SESSIONS)
      dao.evictGatewayOrphanedTranscripts(gateway)
    }
  }

  override suspend fun clearGateway(gatewayId: String) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val dao = database.dao()
    database.withTransaction {
      dao.deleteMessages(gateway)
      dao.deleteSessionsForGateway(gateway)
      dao.deleteGatewayOwner(gateway)
    }
  }

  override suspend fun deleteSession(
    gatewayId: String,
    agentId: String,
    sessionKey: String,
  ) {
    val gateway = scopedGatewayId(gatewayId) ?: return
    val agent = scopedAgentId(agentId) ?: return
    val key = sessionKey.trim().takeIf { it.isNotEmpty() } ?: return
    val dao = database.dao()
    database.withTransaction {
      dao.deleteSessionRow(gateway, agent, key)
      dao.deleteTranscript(gateway, agent, key)
    }
  }

  private fun scopedGatewayId(gatewayId: String): String? = gatewayId.trim().takeIf { it.isNotEmpty() }

  private fun scopedAgentId(agentId: String): String? = agentId.trim().takeIf { it.isNotEmpty() }

  private fun decodeTextParts(encoded: String): List<String> = runCatching { json.decodeFromString(textPartsSerializer, encoded) }.getOrDefault(emptyList())
}
