package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.gateway.GatewayMediaKind
import ai.openclaw.app.gateway.GatewayPreparingPlaybackInterceptor
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

internal class ChatMediaPlaybackClaims<T>(
  private val pause: (T) -> Unit,
  private val release: (T) -> Unit,
) {
  var active: T? = null
    private set

  fun claim(value: T) {
    if (active === value) return
    val previous = active
    active = null
    previous?.let(release)
    active = value
  }

  fun releaseIf(predicate: (T) -> Boolean): Boolean {
    val previous = active?.takeIf(predicate) ?: return false
    active = null
    release(previous)
    return true
  }

  fun pauseIf(predicate: (T) -> Boolean): Boolean {
    val current = active?.takeIf(predicate) ?: return false
    pause(current)
    return true
  }

  fun releaseActive() {
    val previous = active ?: return
    active = null
    release(previous)
  }
}

internal class ChatMediaSessionLifecycle<T : Any, S : Any>(
  private val release: (S) -> Unit,
) {
  private var activeOwner: T? = null
  private var activeSession: S? = null

  fun activate(
    owner: T,
    create: (T) -> S,
  ): S {
    if (activeOwner === owner) return checkNotNull(activeSession)
    releaseActive()
    return create(owner).also { session ->
      activeOwner = owner
      activeSession = session
    }
  }

  fun release(owner: T): Boolean {
    if (activeOwner !== owner) return false
    releaseActive()
    return true
  }

  private fun releaseActive() {
    activeSession?.let(release)
    activeSession = null
    activeOwner = null
  }
}

@OptIn(UnstableApi::class)
internal fun inlineMediaSessionPlayerCommands(availableCommands: Player.Commands): Player.Commands =
  availableCommands
    .buildUpon()
    .remove(Player.COMMAND_SET_MEDIA_ITEM)
    .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
    .remove(Player.COMMAND_STOP)
    .build()

@OptIn(UnstableApi::class)
private object ChatInlineMediaSessionCallback : MediaSession.Callback {
  override fun onConnect(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
  ): MediaSession.ConnectionResult {
    if (!controller.isTrusted) return MediaSession.ConnectionResult.reject()
    return MediaSession.ConnectionResult
      .AcceptedResultBuilder(session)
      .setAvailablePlayerCommands(inlineMediaSessionPlayerCommands(session.player.availableCommands))
      .build()
  }
}

private object ChatMediaPlaybackArbiter {
  private data class AudioFocusHandle(
    val manager: AudioManager,
    val request: AudioFocusRequest,
  )

  private class ActivePlayback(
    val player: ExoPlayer,
    val onReleased: () -> Unit,
  ) {
    var audioFocus: AudioFocusHandle? = null
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val claims = ChatMediaPlaybackClaims<ActivePlayback>(::pauseAndAbandon, ::stopAndRelease)
  private val sessions = ChatMediaSessionLifecycle<ExoPlayer, MediaSession>(MediaSession::release)
  private var playbackIntentGeneration = 0L

  @Synchronized
  fun claimPlaybackIntent(preservePlayer: ExoPlayer? = null): Long {
    if (claims.active?.player !== preservePlayer) claims.releaseActive()
    playbackIntentGeneration += 1L
    return playbackIntentGeneration
  }

  @Synchronized
  fun isCurrentIntent(generation: Long): Boolean = playbackIntentGeneration == generation

  @Synchronized
  fun cancelIntent(generation: Long) {
    if (playbackIntentGeneration == generation) playbackIntentGeneration += 1L
  }

  @Synchronized
  fun pauseAll() {
    playbackIntentGeneration += 1L
    claims.pauseIf { true }
  }

  @Synchronized
  fun registerPrepared(
    player: ExoPlayer,
    intentGeneration: Long,
    onReleased: () -> Unit,
  ): Boolean {
    if (playbackIntentGeneration != intentGeneration) return false
    if (claims.active?.player === player) return true
    claims.claim(ActivePlayback(player = player, onReleased = onReleased))
    return true
  }

  @Synchronized
  fun requestPlayback(
    context: Context,
    player: ExoPlayer,
    intentGeneration: Long,
    onReleased: () -> Unit,
  ): Boolean {
    if (playbackIntentGeneration != intentGeneration) return false
    val existing = claims.active?.takeIf { it.player === player }
    if (existing?.audioFocus != null) return true

    val audioManager = context.getSystemService(AudioManager::class.java)
    val focusRequest =
      AudioFocusRequest
        .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          android.media.AudioAttributes
            .Builder()
            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_UNKNOWN)
            .build(),
        ).setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener { change ->
          if (change < 0) {
            mainHandler.post { pause(player) }
          }
        }.build()
    if (audioManager.requestAudioFocus(focusRequest) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      return false
    }
    val playback = existing ?: ActivePlayback(player = player, onReleased = onReleased).also(claims::claim)
    playback.audioFocus = AudioFocusHandle(manager = audioManager, request = focusRequest)
    try {
      sessions.activate(player) { activePlayer ->
        MediaSession
          .Builder(context, activePlayer)
          .setCallback(ChatInlineMediaSessionCallback)
          .build()
      }
    } catch (_: Throwable) {
      pauseAndAbandon(playback)
      return false
    }
    return true
  }

  @Synchronized
  fun pause(player: ExoPlayer): Boolean = claims.pauseIf { it.player === player }

  @Synchronized
  fun release(player: ExoPlayer): Boolean = claims.releaseIf { it.player === player }

  private fun pauseAndAbandon(playback: ActivePlayback) {
    playback.player.pause()
    sessions.release(playback.player)
    playback.audioFocus?.let { focus -> focus.manager.abandonAudioFocusRequest(focus.request) }
    playback.audioFocus = null
  }

  private fun stopAndRelease(playback: ActivePlayback) {
    pauseAndAbandon(playback)
    playback.player.release()
    playback.onReleased()
  }
}

@Composable
internal fun ChatAudioPlayerCard(
  content: ChatMessageContent,
  playbackBlocked: Boolean,
  loadMedia: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
) {
  ChatMediaPlayerCard(
    content = content,
    kind = GatewayMediaKind.Audio,
    playbackBlocked = playbackBlocked,
    loadMedia = loadMedia,
  )
}

@Composable
internal fun ChatVideoPlayerCard(
  content: ChatMessageContent,
  playbackBlocked: Boolean,
  loadMedia: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
) {
  ChatMediaPlayerCard(
    content = content,
    kind = GatewayMediaKind.Video,
    playbackBlocked = playbackBlocked,
    loadMedia = loadMedia,
  )
}

@OptIn(UnstableApi::class)
@Composable
private fun ChatMediaPlayerCard(
  content: ChatMessageContent,
  kind: GatewayMediaKind,
  playbackBlocked: Boolean,
  loadMedia: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val currentPlaybackBlocked by rememberUpdatedState(playbackBlocked)
  val scope = rememberCoroutineScope()
  var player by remember(content.artifactId, kind) { mutableStateOf<ExoPlayer?>(null) }
  var tempFile by remember(content.artifactId, kind) { mutableStateOf<File?>(null) }
  var loading by remember(content.artifactId, kind) { mutableStateOf(false) }
  var error by remember(content.artifactId, kind) { mutableStateOf<String?>(null) }
  var isPlaying by remember(content.artifactId, kind) { mutableStateOf(false) }
  var positionMs by remember(content.artifactId, kind) { mutableLongStateOf(0L) }
  var durationMs by remember(content.artifactId, kind) { mutableLongStateOf(content.durationMs?.coerceAtLeast(0L) ?: 0L) }
  var playbackIntent by remember(content.artifactId, kind) { mutableLongStateOf(0L) }

  fun clearPlayerState(
    released: ExoPlayer,
    releasedFile: File?,
  ) {
    if (player === released) player = null
    if (tempFile === releasedFile) tempFile = null
    releasedFile?.delete()
    isPlaying = false
    positionMs = 0L
  }

  fun disposeUnclaimedPlayer(
    released: ExoPlayer,
    releasedFile: File?,
  ) {
    released.release()
    clearPlayerState(released, releasedFile)
  }

  fun requestPlayback(
    requested: ExoPlayer,
    requestedFile: File?,
    intentGeneration: Long,
  ): Boolean =
    ChatMediaPlaybackArbiter.requestPlayback(
      context = context,
      player = requested,
      intentGeneration = intentGeneration,
      onReleased = { clearPlayerState(requested, requestedFile) },
    )

  fun registerPrepared(
    prepared: ExoPlayer,
    preparedFile: File?,
    intentGeneration: Long,
  ): Boolean =
    ChatMediaPlaybackArbiter.registerPrepared(
      player = prepared,
      intentGeneration = intentGeneration,
      onReleased = { clearPlayerState(prepared, preparedFile) },
    )

  fun pause() {
    player?.let(ChatMediaPlaybackArbiter::pause)
  }

  fun play() {
    if (playbackBlocked) return
    val existing = player
    if (existing != null) {
      val intentGeneration = ChatMediaPlaybackArbiter.claimPlaybackIntent(preservePlayer = existing)
      playbackIntent = intentGeneration
      error = null
      if (requestPlayback(existing, tempFile, intentGeneration)) {
        if (existing.playbackState == Player.STATE_ENDED) existing.seekToDefaultPosition()
        existing.play()
      } else {
        error = nativeString("Audio playback is unavailable")
      }
      return
    }
    val artifactId = content.artifactId?.trim()?.takeIf(String::isNotEmpty)
    if (artifactId == null) {
      error = nativeString("Media unavailable")
      return
    }
    if (loading) return
    val intentGeneration = ChatMediaPlaybackArbiter.claimPlaybackIntent()
    playbackIntent = intentGeneration
    loading = true
    error = null
    scope.launch {
      val loaded =
        try {
          loadMedia(artifactId, kind, content.playback == "transcode")
        } catch (error: CancellationException) {
          throw error
        } catch (_: Throwable) {
          null
        }
      if (loaded == null) {
        loading = false
        error = nativeString("Media unavailable")
        return@launch
      }
      if (!ChatMediaPlaybackArbiter.isCurrentIntent(intentGeneration)) {
        loading = false
        return@launch
      }
      val prepared = prepareMediaSource(context = context, loaded = loaded)
      if (prepared == null) {
        loading = false
        error = nativeString("Media unavailable")
        return@launch
      }
      if (!ChatMediaPlaybackArbiter.isCurrentIntent(intentGeneration)) {
        prepared.tempFile?.delete()
        loading = false
        return@launch
      }
      tempFile?.delete()
      tempFile = prepared.tempFile
      val created =
        runCatching { buildMediaPlayer(context = context, source = prepared) }.getOrElse {
          prepared.tempFile?.delete()
          tempFile = null
          loading = false
          error = nativeString("Media unavailable")
          return@launch
        }
      created.addListener(
        object : Player.Listener {
          override fun onIsPlayingChanged(value: Boolean) {
            isPlaying = value
          }

          override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_READY) loading = false
            if (playbackState == Player.STATE_ENDED) {
              ChatMediaPlaybackArbiter.pause(created)
            }
          }

          override fun onPlayerError(playbackException: PlaybackException) {
            loading = false
            if (!ChatMediaPlaybackArbiter.release(created)) {
              disposeUnclaimedPlayer(created, prepared.tempFile)
            }
            error = nativeString("Media unavailable")
          }
        },
      )
      player = created
      if (content.playback != "transcode") loading = false
      if (!registerPrepared(created, prepared.tempFile, intentGeneration)) {
        disposeUnclaimedPlayer(created, prepared.tempFile)
        return@launch
      }
      val shouldPlay =
        !currentPlaybackBlocked &&
          lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
      if (shouldPlay && requestPlayback(created, prepared.tempFile, intentGeneration)) {
        created.play()
      } else if (shouldPlay) {
        error = nativeString("Audio playback is unavailable")
      }
    }
  }

  LaunchedEffect(player) {
    val activePlayer = player ?: return@LaunchedEffect
    while (currentCoroutineContext().isActive) {
      positionMs = activePlayer.currentPosition.coerceAtLeast(0L)
      activePlayer.duration.takeIf { it != C.TIME_UNSET && it > 0L }?.let { durationMs = it }
      delay(if (activePlayer.isPlaying) 250L else 1_000L)
    }
  }
  LaunchedEffect(playbackBlocked) {
    if (playbackBlocked) ChatMediaPlaybackArbiter.pauseAll()
  }
  DisposableEffect(lifecycleOwner, player) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) ChatMediaPlaybackArbiter.pauseAll()
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }
  DisposableEffect(content.artifactId, kind) {
    onDispose {
      ChatMediaPlaybackArbiter.cancelIntent(playbackIntent)
      player?.let { activePlayer ->
        val activeFile = tempFile
        if (!ChatMediaPlaybackArbiter.release(activePlayer)) {
          activePlayer.release()
          activeFile?.delete()
        }
      }
      tempFile?.delete()
    }
  }

  if (kind == GatewayMediaKind.Video) {
    VideoPlayerSurface(
      content = content,
      player = player,
      loading = loading,
      preparingPlayback = loading && content.playback == "transcode",
      isPlaying = isPlaying,
      playbackBlocked = playbackBlocked,
      error = error,
      onToggle = { if (isPlaying) pause() else play() },
    )
  } else {
    AudioPlayerSurface(
      content = content,
      loading = loading,
      preparingPlayback = loading && content.playback == "transcode",
      isPlaying = isPlaying,
      playbackBlocked = playbackBlocked,
      error = error,
      positionMs = positionMs,
      durationMs = durationMs,
      onToggle = { if (isPlaying) pause() else play() },
      onSeek = { value ->
        val target = value.toLong().coerceIn(0L, durationMs.coerceAtLeast(0L))
        positionMs = target
        player?.seekTo(target)
      },
      seekEnabled = player != null,
    )
  }
}

@Composable
private fun AudioPlayerSurface(
  content: ChatMessageContent,
  loading: Boolean,
  preparingPlayback: Boolean,
  isPlaying: Boolean,
  playbackBlocked: Boolean,
  error: String?,
  positionMs: Long,
  durationMs: Long,
  onToggle: () -> Unit,
  onSeek: (Float) -> Unit,
  seekEnabled: Boolean,
) {
  Surface(
    shape = RoundedCornerShape(10.dp),
    color = ClawTheme.colors.surfacePressed.copy(alpha = 0.72f),
    border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.6f)),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Surface(
          onClick = onToggle,
          enabled = !playbackBlocked && !loading,
          shape = CircleShape,
          color = ClawTheme.colors.primary,
          contentColor = ClawTheme.colors.primaryText,
        ) {
          Box(modifier = Modifier.size(34.dp), contentAlignment = Alignment.Center) {
            if (loading) {
              CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            } else {
              Icon(
                imageVector = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                contentDescription = if (isPlaying) nativeString("Pause audio") else nativeString("Play audio"),
                modifier = Modifier.size(19.dp),
              )
            }
          }
        }
        Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(16.dp), tint = ClawTheme.colors.textMuted)
        Column(modifier = Modifier.weight(1f)) {
          Text(
            text = content.fileName?.takeIf(String::isNotBlank) ?: nativeString("Voice note"),
            style = ClawTheme.type.body,
            color = ClawTheme.colors.text,
          )
          val status =
            when {
              error != null -> error
              preparingPlayback -> nativeString("Preparing playback…")
              playbackBlocked -> nativeString("Paused for voice playback")
              else -> null
            }
          status?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
        }
      }
      Slider(
        value = positionMs.coerceIn(0L, durationMs.coerceAtLeast(0L)).toFloat(),
        onValueChange = onSeek,
        valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
        enabled = seekEnabled && durationMs > 0L && playerControlsAvailable(error, playbackBlocked),
      )
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(formatVoiceNoteDuration(positionMs), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        Text(formatVoiceNoteDuration(durationMs), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoPlayerSurface(
  content: ChatMessageContent,
  player: ExoPlayer?,
  loading: Boolean,
  preparingPlayback: Boolean,
  isPlaying: Boolean,
  playbackBlocked: Boolean,
  error: String?,
  onToggle: () -> Unit,
) {
  val ratio =
    remember(content.width, content.height) {
      val width = content.width?.takeIf { it > 0 }
      val height = content.height?.takeIf { it > 0 }
      if (width != null && height != null) width.toFloat() / height.toFloat() else 16f / 9f
    }
  Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
    Box(
      modifier =
        Modifier
          .fillMaxWidth()
          .aspectRatio(ratio.coerceIn(0.5f, 2.4f))
          .background(ClawTheme.colors.surfacePressed, RoundedCornerShape(10.dp)),
      contentAlignment = Alignment.Center,
    ) {
      if (player != null) {
        AndroidView(
          factory = { viewContext ->
            PlayerView(viewContext).apply {
              useController = false
              resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
              this.player = player
            }
          },
          update = { it.player = player },
          modifier = Modifier.matchParentSize(),
        )
      } else {
        Icon(Icons.Default.Videocam, contentDescription = null, modifier = Modifier.size(36.dp), tint = ClawTheme.colors.textMuted)
      }
      Box(
        modifier = Modifier.matchParentSize().clickable(enabled = !playbackBlocked && !loading, onClick = onToggle),
        contentAlignment = Alignment.Center,
      ) {
        if (loading) {
          CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
        } else if (!isPlaying) {
          Surface(shape = CircleShape, color = ClawTheme.colors.primary, contentColor = ClawTheme.colors.primaryText) {
            Icon(Icons.Default.PlayArrow, contentDescription = nativeString("Play video"), modifier = Modifier.padding(10.dp).size(24.dp))
          }
        }
      }
    }
    Text(
      text = content.fileName?.takeIf(String::isNotBlank) ?: nativeString("Video"),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    val status =
      when {
        error != null -> error
        preparingPlayback -> nativeString("Preparing playback…")
        playbackBlocked -> nativeString("Paused for voice playback")
        else -> null
      }
    status?.let {
      Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

private fun playerControlsAvailable(
  error: String?,
  playbackBlocked: Boolean,
): Boolean = error == null && !playbackBlocked

@OptIn(UnstableApi::class)
private suspend fun prepareMediaSource(
  context: Context,
  loaded: GatewayLoadedMedia,
): PreparedMediaSource? {
  return when (loaded) {
    is GatewayLoadedMedia.Buffered -> {
      val file = writeBufferedMediaFile(context = context, bytes = loaded.bytes) ?: return null
      PreparedMediaSource(
        uri = file.toURI().toString(),
        mimeType = loaded.mimeType,
        headers = loaded.headers,
        client = loaded.client,
        tempFile = file,
        retryPreparingPlayback = false,
      )
    }
    is GatewayLoadedMedia.Streaming ->
      PreparedMediaSource(
        uri = loaded.url,
        mimeType = loaded.mimeType,
        headers = loaded.headers,
        client = loaded.client,
        tempFile = null,
        retryPreparingPlayback = loaded.retryPreparingPlayback,
      )
  }
}

private suspend fun writeBufferedMediaFile(
  context: Context,
  bytes: ByteArray,
): File? {
  var created: File? = null
  return try {
    withContext(Dispatchers.IO) {
      File.createTempFile("chat-media-", ".media", context.cacheDir).also { file ->
        created = file
        file.writeBytes(bytes)
      }
    }
  } catch (error: CancellationException) {
    withContext(NonCancellable + Dispatchers.IO) { created?.delete() }
    throw error
  } catch (_: Throwable) {
    withContext(NonCancellable + Dispatchers.IO) { created?.delete() }
    null
  }
}

@OptIn(UnstableApi::class)
private fun buildMediaPlayer(
  context: Context,
  source: PreparedMediaSource,
): ExoPlayer {
  val client =
    if (source.retryPreparingPlayback) {
      source.client
        .newBuilder()
        .addInterceptor(GatewayPreparingPlaybackInterceptor())
        .build()
    } else {
      source.client
    }
  val httpFactory = OkHttpDataSource.Factory(client).setDefaultRequestProperties(source.headers)
  val dataSourceFactory = DefaultDataSource.Factory(context, httpFactory)
  val player =
    ExoPlayer
      .Builder(context)
      .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
      .build()
  player.setAudioAttributes(
    AudioAttributes
      .Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_UNKNOWN)
      .build(),
    false,
  )
  player.setMediaItem(
    MediaItem
      .Builder()
      .setUri(source.uri)
      .apply { source.mimeType?.let(::setMimeType) }
      .build(),
  )
  player.prepare()
  return player
}

private data class PreparedMediaSource(
  val uri: String,
  val mimeType: String?,
  val headers: Map<String, String>,
  val client: okhttp3.OkHttpClient,
  val tempFile: File?,
  val retryPreparingPlayback: Boolean,
)

internal fun ChatMessageContent.isVideoAttachment(): Boolean = type == "video" || mimeType?.startsWith("video/") == true

internal fun ChatMessageContent.hasPlayableMediaArtifact(): Boolean = !artifactId.isNullOrBlank()

@Composable
internal fun ChatMediaAttachmentLabel(content: ChatMessageContent) {
  val isAudio = content.isAudioAttachment()
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Icon(
      imageVector = if (isAudio) Icons.Default.Mic else Icons.Default.Videocam,
      contentDescription = null,
      modifier = Modifier.size(16.dp),
      tint = ClawTheme.colors.textMuted,
    )
    Text(
      text =
        content.fileName?.takeIf(String::isNotBlank)
          ?: if (isAudio) nativeString("Voice note") else nativeString("Video"),
      style = ClawTheme.type.body,
      color = ClawTheme.colors.text,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f),
    )
    content.durationMs?.let { duration ->
      Text(
        text = formatVoiceNoteDuration(duration),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
  }
}
