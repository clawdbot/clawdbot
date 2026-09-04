package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.provider.ContactsContract
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowContentResolver

class ContactsHandlerTest : NodeHandlerRobolectricTest() {
  @Test
  fun handleContactsSearch_requiresReadPermission() {
    val handler = ContactsHandler(appContext(), FakeContactsDataSource(canRead = false))

    val result = handler.handleContactsSearch(null)

    assertFalse(result.ok)
    assertEquals("CONTACTS_PERMISSION_REQUIRED", result.error?.code)
  }

  @Test
  fun handleContactsAdd_rejectsEmptyContact() {
    val handler =
      ContactsHandler(
        appContext(),
        FakeContactsDataSource(canRead = true, canWrite = true),
      )

    val result = handler.handleContactsAdd("""{"givenName":" ","emails":[]}""")

    assertFalse(result.ok)
    assertEquals("CONTACTS_INVALID", result.error?.code)
  }

  @Test
  fun handleContactsSearch_returnsContacts() {
    val contact =
      ContactRecord(
        identifier = "1",
        displayName = "Ada Lovelace",
        givenName = "Ada",
        familyName = "Lovelace",
        organizationName = "Analytical Engine",
        phoneNumbers = listOf("+12025550123"),
        emails = listOf("ada@example.com"),
      )
    val handler =
      ContactsHandler(
        appContext(),
        FakeContactsDataSource(canRead = true, searchResults = listOf(contact)),
      )

    val result = handler.handleContactsSearch("""{"query":"ada","limit":1}""")

    assertTrue(result.ok)
    assertEquals(
      Json.parseToJsonElement(
        """{"contacts":[{"identifier":"1","displayName":"Ada Lovelace","givenName":"Ada","familyName":"Lovelace","organizationName":"Analytical Engine","phoneNumbers":["+12025550123"],"emails":["ada@example.com"]}]}""",
      ),
      Json.parseToJsonElement(result.payloadJson ?: error("missing payload")),
    )
  }

  @Test
  fun handleContactsSearch_preservesExplicitJsonNullQuery() {
    val source = FakeContactsDataSource(canRead = true)
    val handler = ContactsHandler(appContext(), source)

    val result = handler.handleContactsSearch("""{"query":null}""")

    assertTrue(result.ok)
    assertEquals("null", source.searchedRequest?.query)
    assertEquals(25, source.searchedRequest?.limit)
  }

  @Test
  fun handleContactsAdd_returnsAddedContact() {
    val added =
      ContactRecord(
        identifier = "2",
        displayName = "Grace Hopper",
        givenName = "Grace",
        familyName = "Hopper",
        organizationName = "US Navy",
        phoneNumbers = listOf(),
        emails = listOf("grace@example.com"),
      )
    val source = FakeContactsDataSource(canRead = true, canWrite = true, addResult = added)
    val handler = ContactsHandler(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """{"givenName":"Grace","familyName":"Hopper","emails":["grace@example.com"]}""",
      )

    assertTrue(result.ok)
    assertEquals(
      Json.parseToJsonElement(
        """{"contact":{"identifier":"2","displayName":"Grace Hopper","givenName":"Grace","familyName":"Hopper","organizationName":"US Navy","phoneNumbers":[],"emails":["grace@example.com"]}}""",
      ),
      Json.parseToJsonElement(result.payloadJson ?: error("missing payload")),
    )
    assertEquals(1, source.addCalls)
  }

  @Test
  fun handleContactsAdd_omitsExplicitJsonNullFields() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """
        {"givenName":"Grace","familyName":null,"organizationName":null,"displayName":null,
         "phoneNumbers":[null,"+15550100"],"emails":[null]}
        """.trimIndent(),
      )

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals("Grace", request.givenName)
    assertNull(request.familyName)
    assertNull(request.organizationName)
    assertNull(request.displayName)
    assertEquals(listOf("+15550100"), request.phoneNumbers)
    assertTrue(request.emails.isEmpty())
  }

  @Test
  fun handleContactsAdd_rejectsOnlyExplicitJsonNullFields() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler(appContext(), source)

    val result =
      handler.handleContactsAdd(
        """{"givenName":null,"familyName":null,"organizationName":null,"phoneNumbers":[null],"emails":[null]}""",
      )

    assertFalse(result.ok)
    assertEquals("CONTACTS_INVALID", result.error?.code)
    assertEquals(0, source.addCalls)
    assertNull(source.addedRequest)
  }

  @Test
  fun handleContactsAdd_preservesLiteralNullStrings() {
    val source = FakeContactsDataSource(canRead = true, canWrite = true)
    val handler = ContactsHandler(appContext(), source)

    val result = handler.handleContactsAdd("""{"givenName":"null","phoneNumbers":["null"]}""")

    assertTrue(result.ok)
    val request = source.addedRequest ?: error("missing add request")
    assertEquals("null", request.givenName)
    assertEquals(listOf("null"), request.phoneNumbers)
  }

  @Test
  fun handleContactsAdd_usesOrganizationAsDisplayNameWhenContactHasNoName() {
    assertSystemContactDisplayName(
      """{"organizationName":"Analytical Engine"}""",
      "Analytical Engine",
    )
  }

  @Test
  fun handleContactsAdd_usesPhoneAsDisplayNameWhenContactHasNoName() {
    assertSystemContactDisplayName(
      """{"phoneNumbers":["+12025550123"]}""",
      "+12025550123",
    )
  }

  @Test
  fun handleContactsAdd_usesEmailAsDisplayNameWhenContactHasNoName() {
    assertSystemContactDisplayName(
      """{"emails":["ADA@EXAMPLE.COM"]}""",
      "ada@example.com",
    )
  }

  @Test
  fun handleContactsAdd_prefersOrganizationOverPhoneAndEmailForDisplayName() {
    assertSystemContactDisplayName(
      """{"organizationName":"Analytical Engine","phoneNumbers":["+12025550123"],"emails":["ada@example.com"]}""",
      "Analytical Engine",
    )
  }

  @Test
  fun handleContactsAdd_prefersPhoneOverEmailForDisplayName() {
    assertSystemContactDisplayName(
      """{"phoneNumbers":["+12025550123"],"emails":["ada@example.com"]}""",
      "+12025550123",
    )
  }

  @Test
  fun handleContactsAdd_preservesStructuredNameOverOrganizationForDisplayName() {
    assertSystemContactDisplayName(
      """{"givenName":"Ada","familyName":"Lovelace","organizationName":"Analytical Engine"}""",
      "Ada Lovelace",
    )
  }

  @Test
  fun handleContactsAdd_preservesExplicitDisplayNameOverOrganization() {
    assertSystemContactDisplayName(
      """{"displayName":"Countess Lovelace","organizationName":"Analytical Engine"}""",
      "Countess Lovelace",
    )
  }

  private fun assertSystemContactDisplayName(
    params: String,
    expectedDisplayName: String,
  ) {
    val app = appContext() as Application
    shadowOf(app).grantPermissions(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
    val provider = TestContactsProvider()
    provider.attachInfo(app, ProviderInfo().apply { authority = ContactsContract.AUTHORITY })
    ShadowContentResolver.registerProviderInternal(ContactsContract.AUTHORITY, provider)
    val handler = ContactsHandler(app)

    val addResult = handler.handleContactsAdd(params)

    assertTrue("contacts.add failed: ${addResult.error?.message}", addResult.ok)
    val added =
      Json
        .parseToJsonElement(addResult.payloadJson ?: error("missing add payload"))
        .jsonObject
        .getValue("contact")
        .jsonObject
    assertEquals(expectedDisplayName, added.getValue("displayName").jsonPrimitive.content)

    val searchResult = handler.handleContactsSearch("""{"query":"$expectedDisplayName"}""")

    assertTrue("contacts.search failed: ${searchResult.error?.message}", searchResult.ok)
    val found =
      Json
        .parseToJsonElement(searchResult.payloadJson ?: error("missing search payload"))
        .jsonObject
        .getValue("contacts")
        .jsonArray
        .single()
        .jsonObject
    assertEquals(added.getValue("identifier").jsonPrimitive.content, found.getValue("identifier").jsonPrimitive.content)
    assertEquals(expectedDisplayName, found.getValue("displayName").jsonPrimitive.content)
  }
}

private class TestContactsProvider : ContentProvider() {
  private val database =
    SQLiteDatabase.create(null).apply {
      execSQL("CREATE TABLE raw_contacts (_id INTEGER PRIMARY KEY, contact_id INTEGER)")
      execSQL("CREATE TABLE contacts (_id INTEGER PRIMARY KEY, display_name TEXT)")
      execSQL(
        "CREATE TABLE data (_id INTEGER PRIMARY KEY AUTOINCREMENT, raw_contact_id INTEGER, " +
          "contact_id INTEGER, mimetype TEXT, data1 TEXT, data2 TEXT, data3 TEXT)",
      )
    }
  private val displayPriorities = mutableMapOf<Long, Int>()

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val paths = uri.pathSegments
    val mimeType =
      when (paths.getOrNull(1)) {
        "phones" -> ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE
        "emails" -> ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE
        else -> null
      }
    val clauses = listOfNotNull(selection, mimeType?.let { "${ContactsContract.Data.MIMETYPE}=?" })
    val arguments = selectionArgs?.toList().orEmpty() + listOfNotNull(mimeType)
    return database.query(
      paths.first(),
      projection,
      clauses.joinToString(" AND ").ifEmpty { null },
      arguments.toTypedArray().takeIf { it.isNotEmpty() },
      null,
      null,
      sortOrder,
    )
  }

  override fun insert(
    uri: Uri,
    values: ContentValues?,
  ): Uri =
    when (uri.pathSegments.first()) {
      "raw_contacts" -> {
        val contactId = database.insertOrThrow("contacts", null, ContentValues().apply { putNull("display_name") })
        val rawContactId =
          database.insertOrThrow(
            "raw_contacts",
            null,
            ContentValues().apply { put(ContactsContract.RawContacts.CONTACT_ID, contactId) },
          )
        ContentUris.withAppendedId(uri, rawContactId)
      }

      "data" -> {
        val row = ContentValues(requireNotNull(values))
        val rawContactId = row.getAsLong(ContactsContract.Data.RAW_CONTACT_ID)
        val contactId =
          database
            .query(
              "raw_contacts",
              arrayOf(ContactsContract.RawContacts.CONTACT_ID),
              "${ContactsContract.RawContacts._ID}=?",
              arrayOf(rawContactId.toString()),
              null,
              null,
              null,
            ).use { cursor ->
              check(cursor.moveToFirst())
              cursor.getLong(0)
            }
        row.put(ContactsContract.Data.CONTACT_ID, contactId)
        val dataId = database.insertOrThrow("data", null, row)
        updateDisplayName(contactId, row)
        ContentUris.withAppendedId(uri, dataId)
      }

      else -> {
        error("unexpected contacts URI: $uri")
      }
    }

  private fun updateDisplayName(
    contactId: Long,
    row: ContentValues,
  ) {
    val mimeType = row.getAsString(ContactsContract.Data.MIMETYPE)
    val priority =
      when (mimeType) {
        ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> 40
        ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE -> 30
        ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> 20
        ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE -> 10
        else -> return
      }
    if (priority < (displayPriorities[contactId] ?: 0)) return
    val display =
      row.getAsString(ContactsContract.Data.DATA1)
        ?: listOfNotNull(
          row.getAsString(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME),
          row.getAsString(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME),
        ).joinToString(" ")
    if (display.isBlank()) return
    database.update(
      "contacts",
      ContentValues().apply { put(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY, display) },
      "${ContactsContract.Contacts._ID}=?",
      arrayOf(contactId.toString()),
    )
    displayPriorities[contactId] = priority
  }

  override fun delete(
    uri: Uri,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun getType(uri: Uri): String? = null
}

private class FakeContactsDataSource(
  private val canRead: Boolean,
  private val canWrite: Boolean = false,
  private val searchResults: List<ContactRecord> = emptyList(),
  private val addResult: ContactRecord =
    ContactRecord(
      identifier = "0",
      displayName = "Default",
      givenName = "",
      familyName = "",
      organizationName = "",
      phoneNumbers = emptyList(),
      emails = emptyList(),
    ),
) : ContactsDataSource {
  var addCalls: Int = 0
    private set

  var searchedRequest: ContactsSearchRequest? = null
    private set

  var addedRequest: ContactsAddRequest? = null
    private set

  override fun hasReadPermission(context: Context): Boolean = canRead

  override fun hasWritePermission(context: Context): Boolean = canWrite

  override fun search(
    context: Context,
    request: ContactsSearchRequest,
  ): List<ContactRecord> {
    searchedRequest = request
    return searchResults
  }

  override fun add(
    context: Context,
    request: ContactsAddRequest,
  ): ContactRecord {
    addCalls += 1
    addedRequest = request
    return addResult
  }
}
