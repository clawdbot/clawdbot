import Foundation

struct IOSDeviceSettingsDocument {
    struct RequestIdentity: Equatable, Sendable {
        fileprivate let documentID: UUID
        fileprivate let authorityGeneration: UInt64
    }

    private(set) var id = UUID()
    private(set) var isAvailable = false
    private var hasCommittedDocument = false

    func requestIdentity(authorityGeneration: UInt64) -> RequestIdentity {
        RequestIdentity(documentID: self.id, authorityGeneration: authorityGeneration)
    }

    func accepts(_ request: RequestIdentity, authorityGeneration: UInt64) -> Bool {
        self.isAvailable && request.documentID == self.id && request.authorityGeneration == authorityGeneration
    }

    mutating func invalidateRequests() {
        self.id = UUID()
    }

    mutating func startNavigation() {
        self.invalidateRequests()
        self.isAvailable = false
    }

    mutating func commitNavigation() {
        self.hasCommittedDocument = true
        self.isAvailable = true
    }

    mutating func failProvisionalNavigation() {
        // WebKit retains the committed page when the replacement fails before committing.
        // Its future requests get a new generation; retired requests never regain authority.
        self.invalidateRequests()
        self.isAvailable = self.hasCommittedDocument
    }

    mutating func retire() {
        self.invalidateRequests()
        self.isAvailable = false
        self.hasCommittedDocument = false
    }
}
