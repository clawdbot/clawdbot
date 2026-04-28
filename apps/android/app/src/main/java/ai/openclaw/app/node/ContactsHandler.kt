package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val DEFAULT_CONTACTS_LIMIT = 25

internal data class ContactRecord(
  val identifier: String,
  val displayName: String,
  val givenName: String,
  val familyName: String,
  val organizationName: String,
  val phoneNumbers: List<String>,
  val emails: List<String>,
)

internal data class ContactsSearchRequest(
  val query: String?,
  val limit: Int,
)

internal data class ContactsAddRequest(
  val givenName: String?,
  val familyName: String?,
  val organizationName: String?,
  val displayName: String?,
  val phoneNumbers: List<String>,
  val emails: List<String>,
)

internal interface ContactsDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun hasWritePermission(context: Context): Boolean

  fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord>

  fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord
}

private object SystemContactsDataSource : ContactsDataSource {
  override fun hasReadPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun hasWritePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord> {
    val resolver = context.contentResolver
    val projection =
      arrayOf(
        ContactsContract.Contacts._ID,
        ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
      )
    val selection: String?
    val selectionArgs: Array<String>?
    if (request.query.isNullOrBlank()) {
      selection = null
      selectionArgs = null
    } else {
      selection = "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ? ESCAPE '\\'"
      selectionArgs = arrayOf("%${escapeLikePattern(request.query)}%")
    }
    val sortOrder = "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} COLLATE NOCASE ASC LIMIT ${request.limit}"
    resolver
      .query(
        ContactsContract.Contacts.CONTENT_URI,
        projection,
        selection,
        selectionArgs,
        sortOrder,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val idIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
        val displayNameIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
        val out = mutableListOf<ContactRecord>()
        while (cursor.moveToNext() && out.size < request.limit) {
          val contactId = cursor.getLong(idIndex)
          val displayName = cursor.getString(displayNameIndex).orEmpty()
          out += loadContactRecord(resolver, contactId, fallbackDisplayName = displayName)
        }
        return out
      }
  }

  override fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord {
    val resolver = context.contentResolver
    val operations = ArrayList<ContentProviderOperation>()
    operations +=
      ContentProviderOperation
        .newInsert(ContactsContract.RawContacts.CONTENT_URI)
        .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
        .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
        .build()
    if (!request.givenName.isNullOrEmpty() || !request.familyName.isNullOrEmpty() || !request.displayName.isNullOrEmpty()) {
      operations +=
        ContentProviderOperation
          .newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME, request.givenName)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME, request.familyName)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, request.displayName)
          .build()
    }
    if (!request.organizationName.isNullOrEmpty()) {
      operations +=
        ContentProviderOperation
          .newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, request.organizationName)
          .build()
    }
    request.phoneNumbers.forEach { number ->
      operations +=
        ContentProviderOperation
          .newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
          .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
          .build()
    }
    request.emails.forEach { email ->
      operations +=
        ContentProviderOperation
          .newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
          .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_HOME)
          .build()
    }

    val results = resolver.applyBatch(ContactsContract.AUTHORITY, operations)
    val rawContactUri =
      results.firstOrNull()?.uri
        ?: throw IllegalStateException("contact insert failed")
    val rawContactId =
      rawContactUri.lastPathSegment?.toLongOrNull()
        ?: throw IllegalStateException("contact insert failed")
    val contactId =
      resolveContactIdForRawContact(resolver, rawContactId)
        ?: throw IllegalStateException("contact insert failed")
    return loadContactRecord(
      resolver = resolver,
      contactId = contactId,
      fallbackDisplayName = request.displayName.orEmpty(),
    )
  }

  private fun resolveContactIdForRawContact(
    resolver: ContentResolver,
    rawContactId: Long,
  ): Long? {
    val projection = arrayOf(ContactsContract.RawContacts.CONTACT_ID)
    resolver
      .query(
        ContactsContract.RawContacts.CONTENT_URI,
        projection,
        "${ContactsContract.RawContacts._ID}=?",
        arrayOf(rawContactId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        val index = cursor.getColumnIndexOrThrow(ContactsContract.RawContacts.CONTACT_ID)
        return cursor.getLong(index)
      }
  }

  private fun loadContactRecord(
    resolver: ContentResolver,
    contactId: Long,
    fallbackDisplayName: String,
  ): ContactRecord {
    val nameRow = loadNameRow(resolver, contactId)
    val organization = loadOrganization(resolver, contactId)
    val phones = loadPhones(resolver, contactId)
    val emails = loadEmails(resolver, contactId)
    val displayName =
      when {
        !nameRow.displayName.isNullOrEmpty() -> nameRow.displayName
        !fallbackDisplayName.isNullOrEmpty() -> fallbackDisplayName
        else -> listOfNotNull(nameRow.givenName, nameRow.familyName).joinToString(" ").trim()
      }.ifEmpty { "(unnamed)" }
    return ContactRecord(
      identifier = contactId.toString(),
      displayName = displayName,
      givenName = nameRow.givenName.orEmpty(),
      familyName = nameRow.familyName.orEmpty(),
      organizationName = organization.orEmpty(),
      phoneNumbers = phones,
      emails = emails,
    )
  }

  private data class NameRow(
    val givenName: String?,
    val familyName: String?,
    val displayName: String?,
  )

  private fun loadNameRow(
    resolver: ContentResolver,
    contactId: Long,
  ): NameRow {
    val projection =
      arrayOf(
        ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME,
        ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME,
        ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME,
      )
    resolver
      .query(
        ContactsContract.Data.CONTENT_URI,
        projection,
        "${ContactsContract.Data.CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
        arrayOf(
          contactId.toString(),
          ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
        ),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) {
          return NameRow(givenName = null, familyName = null, displayName = null)
        }
        val given = cursor.getString(0)?.trim()?.ifEmpty { null }
        val family = cursor.getString(1)?.trim()?.ifEmpty { null }
        val display = cursor.getString(2)?.trim()?.ifEmpty { null }
        return NameRow(givenName = given, familyName = family, displayName = display)
      }
  }

  private fun loadOrganization(
    resolver: ContentResolver,
    contactId: Long,
  ): String? {
    val projection = arrayOf(ContactsContract.CommonDataKinds.Organization.COMPANY)
    resolver
      .query(
        ContactsContract.Data.CONTENT_URI,
        projection,
        "${ContactsContract.Data.CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
        arrayOf(contactId.toString(), ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return cursor.getString(0)?.trim()?.ifEmpty { null }
      }
  }

  private fun escapeLikePattern(pattern: String): String = pattern.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

  private fun loadPhones(
    resolver: ContentResolver,
    contactId: Long,
  ): List<String> =
    queryContactValues(
      resolver = resolver,
      contentUri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      valueColumn = ContactsContract.CommonDataKinds.Phone.NUMBER,
      contactIdColumn = ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
      contactId = contactId,
    )

  private fun loadEmails(
    resolver: ContentResolver,
    contactId: Long,
  ): List<String> =
    queryContactValues(
      resolver = resolver,
      contentUri = ContactsContract.CommonDataKinds.Email.CONTENT_URI,
      valueColumn = ContactsContract.CommonDataKinds.Email.ADDRESS,
      contactIdColumn = ContactsContract.CommonDataKinds.Email.CONTACT_ID,
      contactId = contactId,
    )

  private fun queryContactValues(
    resolver: ContentResolver,
    contentUri: android.net.Uri,
    valueColumn: String,
    contactIdColumn: String,
    contactId: Long,
  ): List<String> {
    val projection = arrayOf(valueColumn)
    resolver
      .query(
        contentUri,
        projection,
        "$contactIdColumn=?",
        arrayOf(contactId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null) return emptyList()
        val out = LinkedHashSet<String>()
        while (cursor.moveToNext()) {
          val value = cursor.getString(0)?.trim().orEmpty()
          if (value.isNotEmpty()) out += value
        }
        return out.toList()
      }
  }
}

class ContactsHandler private constructor(
  private val appContext: Context,
  private val dataSource: ContactsDataSource,
) {
  constructor(appContext: Context) : this(appContext = appContext, dataSource = SystemContactsDataSource)

  fun handleContactsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "CONTACTS_PERMISSION_REQUIRED",
        message = "CONTACTS_PERMISSION_REQUIRED: grant Contacts permission",
      )
    }
    val request =
      parseSearchRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    return try {
      val contacts = dataSource.search(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put(
            "contacts",
            buildJsonArray {
              contacts.forEach { add(contactJson(it)) }
            },
          )
        }.toString(),
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "CONTACTS_UNAVAILABLE",
        message = "CONTACTS_UNAVAILABLE: ${err.message ?: "contacts query failed"}",
      )
    }
  }

  fun handleContactsAdd(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasWritePermission(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "CONTACTS_PERMISSION_REQUIRED",
        message = "CONTACTS_PERMISSION_REQUIRED: grant Contacts permission",
      )
    }
    val request =
      parseAddRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object",
        )
    val hasName =
      !(request.givenName.isNullOrEmpty() && request.familyName.isNullOrEmpty() && request.displayName.isNullOrEmpty())
    val hasOrg = !request.organizationName.isNullOrEmpty()
    val hasDetails = request.phoneNumbers.isNotEmpty() || request.emails.isNotEmpty()
    if (!hasName && !hasOrg && !hasDetails) {
      return GatewaySession.InvokeResult.error(
        code = "CONTACTS_INVALID",
        message = "CONTACTS_INVALID: include a name, organization, phone, or email",
      )
    }
    return try {
      val contact = dataSource.add(appContext, request)
      GatewaySession.InvokeResult.ok(
        buildJsonObject {
          put("contact", contactJson(contact))
        }.toString(),
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "CONTACTS_UNAVAILABLE",
        message = "CONTACTS_UNAVAILABLE: ${err.message ?: "contact add failed"}",
      )
    }
  }

  private fun parseSearchRequest(paramsJson: String?): ContactsSearchRequest? {
    if (paramsJson.isNullOrBlank()) {
      return ContactsSearchRequest(query = null, limit = DEFAULT_CONTACTS_LIMIT)
    }
    val params =
      try {
        Json.parseToJsonElement(paramsJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    val query = (params["query"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null }
    val limit = ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_CONTACTS_LIMIT).coerceIn(1, 200)
    return ContactsSearchRequest(query = query, limit = limit)
  }

  private fun parseAddRequest(paramsJson: String?): ContactsAddRequest? {
    val params =
      try {
        paramsJson?.let { Json.parseToJsonElement(it).asObjectOrNull() }
      } catch (_: Throwable) {
        null
      } ?: return null
    return ContactsAddRequest(
      givenName = (params["givenName"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      familyName = (params["familyName"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      organizationName = (params["organizationName"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      displayName = (params["displayName"] as? JsonPrimitive)?.content?.trim()?.ifEmpty { null },
      phoneNumbers = stringArray(params["phoneNumbers"] as? JsonArray),
      emails = stringArray(params["emails"] as? JsonArray).map { it.lowercase() },
    )
  }

  private fun stringArray(array: JsonArray?): List<String> {
    if (array == null) return emptyList()
    return array.mapNotNull { element ->
      (element as? JsonPrimitive)?.content?.trim()?.ifEmpty { null }
    }
  }

  private fun contactJson(contact: ContactRecord): JsonObject =
    buildJsonObject {
      put("identifier", JsonPrimitive(contact.identifier))
      put("displayName", JsonPrimitive(contact.displayName))
      put("givenName", JsonPrimitive(contact.givenName))
      put("familyName", JsonPrimitive(contact.familyName))
      put("organizationName", JsonPrimitive(contact.organizationName))
      put("phoneNumbers", buildJsonArray { contact.phoneNumbers.forEach { add(JsonPrimitive(it)) } })
      put("emails", buildJsonArray { contact.emails.forEach { add(JsonPrimitive(it)) } })
    }

  companion object {
    internal fun forTesting(
      appContext: Context,
      dataSource: ContactsDataSource,
    ): ContactsHandler = ContactsHandler(appContext = appContext, dataSource = dataSource)
  }
}
