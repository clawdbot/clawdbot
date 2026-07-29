package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatWidgetPreview
import ai.openclaw.app.chat.ChatWidgetResource
import ai.openclaw.app.chat.ChatWidgetSurfaceRole
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.buildGatewayTlsConfig
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprint
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.BufferedSource
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val INLINE_WIDGET_PROFILE_PREFIX = "openclaw-inline-widget-"
private const val INLINE_WIDGET_DOCUMENT_MAX_BYTES = 2L * 1024 * 1024
private const val INLINE_WIDGET_FETCH_TIMEOUT_SECONDS = 8L
private const val HTTP_HEADER_ACCEPT = "Accept"
private const val HTTP_HEADER_CACHE_CONTROL = "Cache-Control"

@Composable
internal fun ChatInlineWidget(
  preview: ChatWidgetPreview,
  resolverReady: Boolean,
  resolveResource: suspend (String, ChatWidgetResource?) -> ChatWidgetResource?,
) {
  var resolvedResource by remember(preview.path) { mutableStateOf<ChatWidgetResource?>(null) }
  var unavailable by remember(preview.path) { mutableStateOf(false) }
  var recoveryAttempts by remember(preview.path) { mutableStateOf(0) }
  var refreshInFlight by remember(preview.path) { mutableStateOf(false) }
  var refreshRequestId by remember(preview.path) { mutableStateOf<UUID?>(null) }
  var exportMenuExpanded by remember(preview.path) { mutableStateOf(false) }
  var exportTarget by remember(preview.path) { mutableStateOf<WebView?>(null) }
  var exportInFlight by remember(preview.path) { mutableStateOf(false) }
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val isolatedProfileSupported = remember { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }

  fun export(destination: ChatWidgetExportDestination) {
    val webView = exportTarget ?: return
    exportMenuExpanded = false
    exportTarget = null
    exportInFlight = true
    scope.launch {
      // Let the popup dismiss before PixelCopy snapshots the activity window.
      withFrameNanos { }
      val result =
        try {
          Result.success(exportChatWidgetImage(context, webView, preview.title, destination))
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          Result.failure(error)
        }
      exportInFlight = false
      val message =
        when {
          result.isFailure && destination == ChatWidgetExportDestination.Clipboard -> nativeString("Could not copy widget image")
          result.isFailure -> nativeString("Could not save widget image")
          destination == ChatWidgetExportDestination.Clipboard -> nativeString("Widget image copied")
          else -> nativeString("Widget image saved to Downloads")
        }
      Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
  }

  fun handleFailure(
    resource: ChatWidgetResource,
    rendererGone: Boolean,
  ) {
    if (resolvedResource != resource) return
    if (rendererGone) {
      // onRenderProcessGone destroys the unusable WebView immediately. Drop
      // Compose's resource reference even when its replacement is in flight.
      resolvedResource = null
      unavailable = false
    }
    if (refreshInFlight) return
    if (recoveryAttempts >= ChatWidgetSurfaceRole.entries.size) {
      refreshRequestId = null
      resolvedResource = null
      unavailable = true
      return
    }

    recoveryAttempts += 1
    refreshInFlight = true
    val requestId = UUID.randomUUID()
    refreshRequestId = requestId
    scope.launch {
      val replacement = resolveResource(preview.path, resource)
      if (refreshRequestId != requestId) return@launch
      refreshRequestId = null
      resolvedResource = replacement
      unavailable = replacement == null
      refreshInFlight = false
    }
  }

  LaunchedEffect(preview.path, resolverReady) {
    refreshRequestId = null
    refreshInFlight = false
    if (!resolverReady) return@LaunchedEffect
    resolvedResource = resolveResource(preview.path, null)
    unavailable = resolvedResource == null
    recoveryAttempts = 0
  }

  Column(modifier = Modifier.fillMaxWidth()) {
    preview.title?.trim()?.takeIf(String::isNotEmpty)?.let { title ->
      Text(
        text = title,
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        modifier = Modifier.padding(bottom = 6.dp),
      )
    }
    when {
      resolvedResource != null && isolatedProfileSupported -> {
        val resource = checkNotNull(resolvedResource)
        val allowsScripts = preview.sandbox == "scripts"
        // Resource identity owns the WebView, isolated profile, and cleanup handle together.
        key(resource, allowsScripts) {
          Box {
            Surface(
              modifier = Modifier.fillMaxWidth().height(preview.height.dp),
              shape = RoundedCornerShape(10.dp),
              border = BorderStroke(1.dp, ClawTheme.colors.border),
              color = ClawTheme.colors.surface,
            ) {
              InlineWidgetWebView(
                resource = resource,
                allowsScripts = allowsScripts,
                onLongPress = { webView ->
                  if (!exportInFlight) {
                    exportTarget = webView
                    exportMenuExpanded = true
                  }
                },
                onRelease = { webView ->
                  if (exportTarget === webView) {
                    exportMenuExpanded = false
                    exportTarget = null
                  }
                },
                onFailure = { handleFailure(resource, rendererGone = false) },
                onRendererGone = {
                  exportMenuExpanded = false
                  exportTarget = null
                  handleFailure(resource, rendererGone = true)
                },
              )
            }
            DropdownMenu(
              expanded = exportMenuExpanded,
              onDismissRequest = {
                exportMenuExpanded = false
                exportTarget = null
              },
            ) {
              DropdownMenuItem(
                text = { Text(nativeString("Copy image")) },
                leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
                onClick = { export(ChatWidgetExportDestination.Clipboard) },
              )
              DropdownMenuItem(
                text = { Text(nativeString("Save image")) },
                leadingIcon = { Icon(Icons.Default.Download, contentDescription = null) },
                onClick = { export(ChatWidgetExportDestination.Downloads) },
              )
            }
          }
        }
      }
      unavailable || resolvedResource != null ->
        Text(
          text = nativeString("Widget unavailable"),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      else ->
        Box(modifier = Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.Center) {
          CircularProgressIndicator(color = ClawTheme.colors.textMuted)
        }
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
@Composable
private fun InlineWidgetWebView(
  resource: ChatWidgetResource,
  allowsScripts: Boolean,
  onLongPress: (WebView) -> Unit,
  onRelease: (WebView) -> Unit,
  onFailure: () -> Unit,
  onRendererGone: () -> Unit,
) {
  val profileName = remember(resource, allowsScripts) { "$INLINE_WIDGET_PROFILE_PREFIX${UUID.randomUUID()}" }
  val handle = remember(profileName) { InlineWidgetWebViewHandle() }
  val currentOnLongPress by rememberUpdatedState(onLongPress)
  val currentOnRelease by rememberUpdatedState(onRelease)
  AndroidView(
    modifier = Modifier.fillMaxWidth(),
    factory = { context ->
      pruneStaleInlineWidgetProfiles()
      val webView = WebView(context)
      if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
        WebViewCompat.setProfile(webView, profileName)
      } else {
        error("isolated WebView profiles are unavailable")
      }
      val client =
        InlineWidgetWebViewClient(
          resource = resource,
          onFailure = onFailure,
          onRendererGone = onRendererGone,
        )
      handle.bind(client)
      webView.apply {
        setOnLongClickListener {
          currentOnLongPress(this)
          true
        }
        settings.setAllowContentAccess(false)
        settings.setAllowFileAccess(false)
        settings.setAllowFileAccessFromFileURLs(false)
        settings.setAllowUniversalAccessFromFileURLs(false)
        settings.setSafeBrowsingEnabled(true)
        settings.javaScriptEnabled = allowsScripts
        settings.domStorageEnabled = false
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        isHorizontalScrollBarEnabled = false
        webViewClient = client
        loadUrl(resource.url)
      }
    },
    onRelease = { webView ->
      currentOnRelease(webView)
      handle.release(webView)
      deleteInlineWidgetProfile(profileName)
    },
  )
}

private class InlineWidgetWebViewHandle {
  private var client: InlineWidgetWebViewClient? = null

  fun bind(client: InlineWidgetWebViewClient) {
    this.client = client
  }

  fun release(view: WebView) {
    client?.release(view)
    client = null
  }
}

private fun pruneStaleInlineWidgetProfiles() {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
  val store = ProfileStore.getInstance()
  store.allProfileNames
    .asSequence()
    .filter { it.startsWith(INLINE_WIDGET_PROFILE_PREFIX) }
    .forEach { profileName -> runCatching { store.deleteProfile(profileName) } }
}

private fun deleteInlineWidgetProfile(profileName: String) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
  val store = ProfileStore.getInstance()
  val deleted = runCatching { store.deleteProfile(profileName) }.getOrDefault(false)
  if (!deleted) {
    Handler(Looper.getMainLooper()).post {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
        runCatching { ProfileStore.getInstance().deleteProfile(profileName) }
      }
    }
  }
}

private class InlineWidgetWebViewClient(
  private val resource: ChatWidgetResource,
  private val onFailure: () -> Unit,
  private val onRendererGone: () -> Unit,
) : WebViewClient() {
  private val pinnedClient = resource.tlsFingerprintSha256?.let(::buildPinnedWidgetClient)
  private var released = false

  fun release(view: WebView) {
    if (released) return
    released = true
    view.setOnLongClickListener(null)
    view.stopLoading()
    closePinnedClient()
    view.webViewClient = WebViewClient()
    view.removeAllViews()
    view.destroy()
  }

  private fun releaseAfterRendererGone(view: WebView): Boolean {
    if (released) return false
    released = true
    view.setOnLongClickListener(null)
    // A renderer-less WebView is unusable. Remove and destroy it before
    // starting asynchronous route recovery; onRelease becomes a no-op.
    (view.parent as? ViewGroup)?.removeView(view)
    closePinnedClient()
    view.destroy()
    return true
  }

  private fun closePinnedClient() {
    pinnedClient?.dispatcher?.cancelAll()
    pinnedClient?.connectionPool?.evictAll()
  }

  override fun onPageCommitVisible(
    view: WebView,
    url: String,
  ) {
    // Compose can retain the pre-navigation WebView layer until the first damage event.
    // Invalidate once committed so the initial widget frame paints without user input.
    view.postInvalidateOnAnimation()
  }

  override fun shouldOverrideUrlLoading(
    view: WebView,
    request: WebResourceRequest,
  ): Boolean =
    request.isForMainFrame &&
      (!request.method.equals("GET", ignoreCase = true) || !sameDocument(resource.url, request.url.toString()))

  override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest,
  ): WebResourceResponse? {
    val scheme = request.url.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    val allowed =
      request.isForMainFrame &&
        request.method.equals("GET", ignoreCase = true) &&
        sameDocument(resource.url, request.url.toString())
    if (!allowed) return blockedWidgetResponse()
    if (resource.tlsFingerprintSha256 == null) return null
    if (scheme != "https" || pinnedClient == null) return failedWidgetResponse()
    return fetchPinnedWidgetDocument(client = pinnedClient, url = request.url.toString())
  }

  override fun onReceivedError(
    view: WebView,
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    if (request.isForMainFrame) onFailure()
  }

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    errorResponse: WebResourceResponse,
  ) {
    if (request.isForMainFrame && errorResponse.statusCode >= 400) onFailure()
  }

  override fun onRenderProcessGone(
    view: WebView,
    detail: RenderProcessGoneDetail,
  ): Boolean {
    if (releaseAfterRendererGone(view)) onRendererGone()
    return true
  }
}

private fun buildPinnedWidgetClient(rawFingerprint: String): OkHttpClient? {
  val fingerprint = normalizeGatewayTlsFingerprint(rawFingerprint)
  if (fingerprint.length != 64) return null
  val tls =
    buildGatewayTlsConfig(
      GatewayTlsParams(
        required = true,
        expectedFingerprint = fingerprint,
        allowTOFU = false,
        stableId = "inline-widget",
      ),
    ) ?: return null
  return OkHttpClient
    .Builder()
    .sslSocketFactory(tls.sslSocketFactory, tls.trustManager)
    .hostnameVerifier(tls.hostnameVerifier)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .cache(null)
    .callTimeout(INLINE_WIDGET_FETCH_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    .build()
}

private fun fetchPinnedWidgetDocument(
  client: OkHttpClient,
  url: String,
): WebResourceResponse =
  try {
    val request =
      Request
        .Builder()
        .url(url)
        .header(HTTP_HEADER_ACCEPT, "text/html")
        .header(HTTP_HEADER_CACHE_CONTROL, "no-cache")
        .get()
        .build()
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) return failedWidgetResponse()
      val body = response.body
      val contentType = body.contentType() ?: return failedWidgetResponse()
      val mimeType = "${contentType.type}/${contentType.subtype}".lowercase(Locale.US)
      if (mimeType != "text/html") return failedWidgetResponse()
      val contentLength = body.contentLength()
      if (contentLength > INLINE_WIDGET_DOCUMENT_MAX_BYTES) return failedWidgetResponse()
      val bytes =
        readBoundedWidgetDocument(
          source = body.source(),
          maxBytes = INLINE_WIDGET_DOCUMENT_MAX_BYTES.toInt(),
        ) ?: return failedWidgetResponse()
      val responseHeaders =
        listOf(
          "Cache-Control",
          "Content-Security-Policy",
          "Permissions-Policy",
          "Referrer-Policy",
          "X-Content-Type-Options",
        ).mapNotNull { name -> response.header(name)?.let { name to it } }.toMap()
      WebResourceResponse(
        mimeType,
        contentType.charset(Charsets.UTF_8)?.name() ?: Charsets.UTF_8.name(),
        response.code,
        response.message.ifBlank { "OK" },
        responseHeaders,
        ByteArrayInputStream(bytes),
      )
    }
  } catch (_: Exception) {
    failedWidgetResponse()
  }

internal fun readBoundedWidgetDocument(
  source: BufferedSource,
  maxBytes: Int,
): ByteArray? {
  require(maxBytes in 0 until Int.MAX_VALUE)
  val buffer = ByteArray(maxBytes + 1)
  var offset = 0
  while (offset < buffer.size) {
    val read = source.read(buffer, offset, buffer.size - offset)
    if (read == -1) break
    if (read == 0) return null
    offset += read
  }
  if (offset > maxBytes) return null
  return buffer.copyOf(offset)
}

private fun sameDocument(
  expected: String,
  candidate: String,
): Boolean {
  val expectedUri = runCatching { URI(expected) }.getOrNull() ?: return false
  val candidateUri = runCatching { URI(candidate) }.getOrNull() ?: return false
  return expectedUri.scheme == candidateUri.scheme &&
    expectedUri.rawAuthority == candidateUri.rawAuthority &&
    expectedUri.rawPath == candidateUri.rawPath &&
    expectedUri.rawQuery == candidateUri.rawQuery
}

private fun blockedWidgetResponse(): WebResourceResponse =
  WebResourceResponse(
    "text/plain",
    "UTF-8",
    403,
    "Blocked",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0)),
  )

private fun failedWidgetResponse(): WebResourceResponse =
  WebResourceResponse(
    "text/plain",
    "UTF-8",
    502,
    "Widget unavailable",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0)),
  )
