import Contacts
import Foundation
import OpenClawKit

final class ContactsService: ContactsServicing {
    private static var payloadKeys: [CNKeyDescriptor] {
        [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
        ]
    }

    func search(params: OpenClawContactsSearchParams) async throws -> OpenClawContactsSearchPayload {
        let store = try await Self.authorizedStore()

        let limit = max(1, min(params.limit ?? 25, 200))

        var contacts: [CNContact] = []
        if let query = params.query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            let predicate = CNContact.predicateForContacts(matchingName: query)
            contacts = try store.unifiedContacts(matching: predicate, keysToFetch: Self.payloadKeys)
        } else {
            let request = CNContactFetchRequest(keysToFetch: Self.payloadKeys)
            try store.enumerateContacts(with: request) { contact, stop in
                contacts.append(contact)
                if contacts.count >= limit {
                    stop.pointee = true
                }
            }
        }

        let sliced = Array(contacts.prefix(limit))
        let payload = sliced.map { Self.payload(from: $0) }

        return OpenClawContactsSearchPayload(contacts: payload)
    }

    func add(params: OpenClawContactsAddParams) async throws -> OpenClawContactsAddPayload {
        let store = try await Self.authorizedStore()

        let givenName = params.givenName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let familyName = params.familyName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let organizationName = params.organizationName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = params.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let phoneNumbers = Self.normalizeStrings(params.phoneNumbers)
        let emails = Self.normalizeStrings(params.emails, lowercased: true)

        let hasName = !(givenName ?? "").isEmpty || !(familyName ?? "").isEmpty || !(displayName ?? "").isEmpty
        let hasOrg = !(organizationName ?? "").isEmpty
        let hasDetails = !phoneNumbers.isEmpty || !emails.isEmpty
        guard hasName || hasOrg || hasDetails else {
            throw NSError(domain: "Contacts", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "CONTACTS_INVALID: include a name, organization, phone, or email",
            ])
        }

        if !phoneNumbers.isEmpty || !emails.isEmpty {
            if let existing = try Self.findExistingContact(
                store: store,
                phoneNumbers: phoneNumbers,
                emails: emails)
            {
                return OpenClawContactsAddPayload(contact: Self.payload(from: existing))
            }
        }

        let contact = CNMutableContact()
        contact.givenName = givenName ?? ""
        contact.familyName = familyName ?? ""
        contact.organizationName = organizationName ?? ""
        if contact.givenName.isEmpty, contact.familyName.isEmpty, let displayName {
            contact.givenName = displayName
        }
        contact.phoneNumbers = phoneNumbers.map {
            CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: $0))
        }
        contact.emailAddresses = emails.map {
            CNLabeledValue(label: CNLabelHome, value: $0 as NSString)
        }

        let save = CNSaveRequest()
        save.add(contact, toContainerWithIdentifier: nil)
        try store.execute(save)

        let persisted: CNContact = if !contact.identifier.isEmpty {
            try store.unifiedContact(
                withIdentifier: contact.identifier,
                keysToFetch: Self.payloadKeys)
        } else {
            contact
        }

        return OpenClawContactsAddPayload(contact: Self.payload(from: persisted))
    }

    private static func ensureAuthorization(store: CNContactStore, status: CNAuthorizationStatus) async -> Bool {
        switch status {
        case .authorized, .limited:
            return true
        case .notDetermined:
            // Don’t prompt during node.invoke; the caller should instruct the user to grant permission.
            // Prompts block the invoke and lead to timeouts in headless flows.
            return false
        case .restricted, .denied:
            return false
        @unknown default:
            return false
        }
    }

    private static func authorizedStore() async throws -> CNContactStore {
        let store = CNContactStore()
        let status = CNContactStore.authorizationStatus(for: .contacts)
        let authorized = await Self.ensureAuthorization(store: store, status: status)
        guard authorized else {
            throw NSError(domain: "Contacts", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CONTACTS_PERMISSION_REQUIRED: grant Contacts permission",
            ])
        }
        return store
    }

    private static func normalizeStrings(_ values: [String]?, lowercased: Bool = false) -> [String] {
        (values ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { lowercased ? $0.lowercased() : $0 }
    }

    private static func findExistingContact(
        store: CNContactStore,
        phoneNumbers: [String],
        emails: [String]) throws -> CNContact?
    {
        if phoneNumbers.isEmpty, emails.isEmpty {
            return nil
        }

        var matches: [CNContact] = []

        for phone in phoneNumbers {
            let predicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: phone))
            let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: Self.payloadKeys)
            matches.append(contentsOf: contacts)
        }

        for email in emails {
            let predicate = CNContact.predicateForContacts(matchingEmailAddress: email)
            let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: Self.payloadKeys)
            matches.append(contentsOf: contacts)
        }

        return Self.matchContacts(contacts: matches, phoneNumbers: phoneNumbers, emails: emails)
    }

    private static func matchContacts(
        contacts: [CNContact],
        phoneNumbers: [String],
        emails: [String]) -> CNContact?
    {
        let normalizedPhones = Set(phoneNumbers.map { self.normalizePhone($0) }.filter { !$0.isEmpty })
        let normalizedEmails = Set(emails.map { $0.lowercased() }.filter { !$0.isEmpty })
        var seen = Set<String>()

        for contact in contacts {
            guard seen.insert(contact.identifier).inserted else { continue }
            let contactPhones = Set(contact.phoneNumbers.map { self.normalizePhone($0.value.stringValue) })
            let contactEmails = Set(contact.emailAddresses.map { String($0.value).lowercased() })

            if !normalizedPhones.isEmpty, !contactPhones.isDisjoint(with: normalizedPhones) {
                return contact
            }
            if !normalizedEmails.isEmpty, !contactEmails.isDisjoint(with: normalizedEmails) {
                return contact
            }
        }

        return nil
    }

    private static func normalizePhone(_ phone: String) -> String {
        let trimmed = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }
        let normalized = String(String.UnicodeScalarView(digits))
        return normalized.isEmpty ? trimmed : normalized
    }

    private static func payload(from contact: CNContact) -> OpenClawContactPayload {
        OpenClawContactPayload(
            identifier: contact.identifier,
            displayName: CNContactFormatter.string(from: contact, style: .fullName)
                ?? "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespacesAndNewlines),
            givenName: contact.givenName,
            familyName: contact.familyName,
            organizationName: contact.organizationName,
            phoneNumbers: contact.phoneNumbers.map(\.value.stringValue),
            emails: contact.emailAddresses.map { String($0.value) })
    }

    #if DEBUG
    static func _test_matches(contact: CNContact, phoneNumbers: [String], emails: [String]) -> Bool {
        self.matchContacts(contacts: [contact], phoneNumbers: phoneNumbers, emails: emails) != nil
    }
    #endif
}
