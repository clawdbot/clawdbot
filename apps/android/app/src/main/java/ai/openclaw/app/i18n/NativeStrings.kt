package ai.openclaw.app.i18n

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.util.Xml
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.core.app.LocaleManagerCompat
import androidx.core.os.ConfigurationCompat
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import org.xmlpull.v1.XmlPullParser

sealed interface NativeText {
  data class Resource(
    val source: String,
    val formatArgs: List<Any>,
  ) : NativeText

  data class Verbatim(
    val value: String,
  ) : NativeText

  data class Composite(
    val parts: List<NativeText>,
    val separator: String,
  ) : NativeText
}

private val nativeLocaleRevision = MutableStateFlow(0L)
internal val nativeLocaleChanges: StateFlow<Long> = nativeLocaleRevision.asStateFlow()

internal fun nativeText(
  source: String,
  vararg formatArgs: Any,
): NativeText.Resource = NativeText.Resource(source = source, formatArgs = formatArgs.toList())

internal fun verbatimText(value: String): NativeText = NativeText.Verbatim(value)

internal fun joinedNativeText(
  separator: String,
  parts: List<NativeText>,
): NativeText = NativeText.Composite(parts = parts, separator = separator)

internal fun NativeText.resolveNativeText(): String =
  when (this) {
    is NativeText.Resource -> nativeString(source, *formatArgs.map(::resolveNativeFormatArg).toTypedArray())
    is NativeText.Verbatim -> value
    is NativeText.Composite -> parts.joinToString(separator, transform = NativeText::resolveNativeText)
  }

@Composable
internal fun NativeText.resolveNativeTextResource(): String =
  when (this) {
    is NativeText.Resource -> {
      val resolvedArgs = mutableListOf<Any>()
      for (formatArg in formatArgs) {
        resolvedArgs += if (formatArg is NativeText) formatArg.resolveNativeTextResource() else formatArg
      }
      nativeStringResource(source, *resolvedArgs.toTypedArray())
    }
    is NativeText.Verbatim -> value
    is NativeText.Composite -> {
      val resolvedParts = mutableListOf<String>()
      for (part in parts) {
        resolvedParts += part.resolveNativeTextResource()
      }
      resolvedParts.joinToString(separator)
    }
  }

private fun resolveNativeFormatArg(value: Any): Any = if (value is NativeText) value.resolveNativeText() else value

internal fun notifyNativeLocaleChanged() {
  NativeStringResources.invalidateLocalizedContext()
  nativeLocaleRevision.update { it + 1 }
}

@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
private class LocaleResolvingStateFlow<T, R>(
  private val source: StateFlow<T>,
  private val transform: (T) -> R,
) : StateFlow<R> {
  override val value: R
    get() = transform(source.value)

  override val replayCache: List<R>
    get() = listOf(value)

  override suspend fun collect(collector: FlowCollector<R>): Nothing {
    combine(source, nativeLocaleRevision) { value, _ -> transform(value) }
      .distinctUntilChanged()
      .collect(collector)
    error("locale-resolving state flow completed unexpectedly")
  }
}

internal fun StateFlow<NativeText>.resolveNativeText(): StateFlow<String> = LocaleResolvingStateFlow(this, NativeText::resolveNativeText)

internal fun StateFlow<NativeText?>.resolveOptionalNativeText(): StateFlow<String?> = LocaleResolvingStateFlow(this) { text -> text?.resolveNativeText() }

@SuppressLint("StaticFieldLeak")
internal object NativeStringResources {
  private sealed interface ApplicationLocaleMode {
    val locales: LocaleListCompat

    data class Pinned(
      override val locales: LocaleListCompat,
    ) : ApplicationLocaleMode

    data class System(
      override val locales: LocaleListCompat,
    ) : ApplicationLocaleMode
  }

  @Volatile
  private var applicationContext: Context? = null

  @Volatile
  private var applicationLocaleMode: ApplicationLocaleMode? = null

  @Volatile
  private var localizedContext: Context? = null

  @Synchronized
  fun install(context: Context) {
    val appContext = context.applicationContext
    applicationContext = appContext
    val liveLocales =
      if (Build.VERSION.SDK_INT >= 33) {
        LocaleManagerCompat.getApplicationLocales(appContext)
      } else {
        AppCompatDelegate.getApplicationLocales()
      }
    val requestedLocales = liveLocales.takeUnless { it.isEmpty } ?: appContext.readStoredAppLocales()
    applicationLocaleMode =
      if (requestedLocales.isEmpty) {
        ApplicationLocaleMode.System(ConfigurationCompat.getLocales(appContext.resources.configuration))
      } else {
        ApplicationLocaleMode.Pinned(requestedLocales)
      }
    localizedContext = null
  }

  @Synchronized
  fun setApplicationLocales(locales: LocaleListCompat) {
    applicationLocaleMode =
      if (locales.isEmpty) {
        val context = applicationContext
        ApplicationLocaleMode.System(
          context?.let { ConfigurationCompat.getLocales(it.resources.configuration) }
            ?: LocaleListCompat.getEmptyLocaleList(),
        )
      } else {
        ApplicationLocaleMode.Pinned(locales)
      }
    localizedContext = null
  }

  @Synchronized
  fun setConfigurationLocales(configuration: Configuration) {
    val previousMode = applicationLocaleMode
    val context = applicationContext
    val liveLocales =
      when {
        context == null -> LocaleListCompat.getEmptyLocaleList()
        Build.VERSION.SDK_INT >= 33 -> LocaleManagerCompat.getApplicationLocales(context)
        else -> AppCompatDelegate.getApplicationLocales()
      }
    applicationLocaleMode =
      when {
        !liveLocales.isEmpty -> ApplicationLocaleMode.Pinned(liveLocales)
        Build.VERSION.SDK_INT < 33 && previousMode is ApplicationLocaleMode.Pinned -> previousMode
        else -> ApplicationLocaleMode.System(ConfigurationCompat.getLocales(configuration))
      }
    localizedContext = null
  }

  @Synchronized
  fun invalidateLocalizedContext() {
    localizedContext = null
  }

  fun resolve(
    source: String,
    vararg formatArgs: Any,
  ): String {
    val context = applicationContext ?: return formatNativeSource(source, formatArgs)
    val localized =
      localizedContext
        ?: synchronized(this) {
          localizedContext
            ?: context
              .localizedContext(
                applicationLocaleMode
                  ?.locales
                  ?: LocaleManagerCompat
                    .getApplicationLocales(context)
                    .takeUnless { it.isEmpty }
                  ?: context.readStoredAppLocales(),
              ).also { localizedContext = it }
        }
    return localized.nativeString(source, *formatArgs)
  }
}

private fun Context.localizedContext(locales: LocaleListCompat): Context =
  if (locales.isEmpty) {
    this
  } else {
    val configuration = Configuration(resources.configuration)
    ConfigurationCompat.setLocales(configuration, locales)
    createConfigurationContext(configuration)
  }

private fun Context.readStoredAppLocales(): LocaleListCompat {
  if (Build.VERSION.SDK_INT >= 33) return LocaleListCompat.getEmptyLocaleList()
  // AppCompat only hydrates auto-stored locales when a delegate attaches. A cold service
  // has no delegate, so mirror AndroidX's XML read until the platform owns app locales.
  val languageTags =
    runCatching {
      openFileInput(APP_LOCALES_FILE).use { input ->
        val parser = Xml.newPullParser()
        parser.setInput(input, "UTF-8")
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
          if (parser.eventType == XmlPullParser.START_TAG && parser.name == APP_LOCALES_TAG) {
            return@use parser.getAttributeValue(null, APP_LOCALES_ATTRIBUTE).orEmpty()
          }
        }
        ""
      }
    }.getOrDefault("")
  return LocaleListCompat.forLanguageTags(languageTags)
}

internal fun nativeString(
  source: String,
  vararg formatArgs: Any,
): String = NativeStringResources.resolve(source, *formatArgs)

@Composable
internal fun nativeStringResource(
  source: String,
  vararg formatArgs: Any,
): String {
  val resourceId = nativeStringResourceIds[source] ?: return formatNativeSource(source, formatArgs)
  return if (formatArgs.isEmpty()) stringResource(resourceId) else stringResource(resourceId, *formatArgs)
}

internal fun Context.nativeString(
  source: String,
  vararg formatArgs: Any,
): String {
  val resourceId = nativeStringResourceIds[source] ?: return formatNativeSource(source, formatArgs)
  return if (formatArgs.isEmpty()) getString(resourceId) else getString(resourceId, *formatArgs)
}

private fun formatNativeSource(
  source: String,
  formatArgs: Array<out Any>,
): String {
  if (formatArgs.isEmpty()) return source
  val rendered = StringBuilder(source.length)
  var argumentIndex = 0
  var cursor = 0
  while (cursor < source.length) {
    val start = source.indexOf('$', startIndex = cursor)
    if (start < 0) {
      rendered.append(source, cursor, source.length)
      break
    }
    rendered.append(source, cursor, start)
    val end = source.kotlinInterpolationEnd(start)
    if (end == null) {
      rendered.append('$')
      cursor = start + 1
      continue
    }
    val argument = formatArgs.getOrNull(argumentIndex++)
    if (argument == null) {
      rendered.append(source, start, end)
    } else {
      rendered.append(argument)
    }
    cursor = end
  }
  return rendered.toString()
}

private fun String.kotlinInterpolationEnd(start: Int): Int? {
  val next = getOrNull(start + 1) ?: return null
  if (next != '{') {
    if (next != '_' && !next.isLetter()) return null
    var end = start + 2
    while (getOrNull(end)?.let { it == '_' || it.isLetterOrDigit() } == true) {
      end += 1
    }
    return end
  }

  var depth = 1
  var quote: Char? = null
  var escaped = false
  var end = start + 2
  while (end < length) {
    val character = this[end]
    when {
      escaped -> escaped = false
      quote != null && character == '\\' -> escaped = true
      character == quote -> quote = null
      quote == null && (character == '"' || character == '\'') -> quote = character
      quote == null && character == '{' -> depth += 1
      quote == null && character == '}' -> {
        depth -= 1
        if (depth == 0) return end + 1
      }
    }
    end += 1
  }
  return null
}

private const val APP_LOCALES_FILE =
  "androidx.appcompat.app.AppCompatDelegate.application_locales_record_file"
private const val APP_LOCALES_TAG = "locales"
private const val APP_LOCALES_ATTRIBUTE = "application_locales"
