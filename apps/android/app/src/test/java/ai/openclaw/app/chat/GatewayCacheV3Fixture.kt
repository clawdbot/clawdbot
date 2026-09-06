package ai.openclaw.app.chat

import androidx.room3.Database
import androidx.room3.Entity
import androidx.room3.RoomDatabase

// Frozen v3 session shape: exercise the previous Room opener, not a simulated PRAGMA rollback.
// Unchanged message/owner entities are also checked by the canonical v3 Room identity hash.
@Entity(tableName = "cached_sessions", primaryKeys = ["gatewayId", "agentId", "sessionKey"])
internal data class CachedSessionV3Fixture(
  val gatewayId: String,
  val agentId: String,
  val sessionKey: String,
  val displayName: String?,
  val color: String?,
  val updatedAtMs: Long?,
  val status: String?,
  val startedAt: Long?,
  val endedAt: Long?,
  val runtimeMs: Long?,
  val outputTokens: Long?,
  val hasRunMetadata: Boolean,
  val rowOrder: Int,
)

@Database(
  entities = [CachedSessionV3Fixture::class, CachedMessageEntity::class, CachedGatewayOwnerEntity::class],
  version = 3,
  exportSchema = false,
)
internal abstract class GatewayCacheV3Fixture : RoomDatabase()
