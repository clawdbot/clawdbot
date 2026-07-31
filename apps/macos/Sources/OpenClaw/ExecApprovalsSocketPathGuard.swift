import Darwin
import Foundation

// periphery:ignore:parameters uid,uuid - Darwin consumes both positions through the imported C ABI.
@_silgen_name("mbr_uid_to_uuid")
private func openClawMbrUIDToUUID(
    _ uid: uid_t,
    _ uuid: UnsafeMutablePointer<UInt8>) -> Int32

enum ExecApprovalsSocketPathKind: Equatable {
    case missing
    case directory
    case socket
    case symlink
    case other
}

struct ExecApprovalsSocketPathIdentity: Equatable, Sendable {
    let device: UInt64
    let inode: UInt64
}

enum ExecApprovalsSocketPathGuardError: LocalizedError {
    case lstatFailed(path: String, code: Int32)
    case readlinkFailed(path: String, message: String)
    case parentPathInvalid(path: String, kind: ExecApprovalsSocketPathKind)
    case parentOwnerInvalid(path: String, owner: uid_t, expected: uid_t)
    case parentAncestorOwnerInvalid(path: String, owner: uid_t)
    case parentSymlinkOwnerInvalid(path: String, owner: uid_t)
    case parentPermissionsUnsafe(path: String, permissions: mode_t)
    case parentACLReadFailed(path: String, code: Int32)
    case parentACLUnsafe(path: String)
    case socketPathInvalid(path: String, kind: ExecApprovalsSocketPathKind)
    case unlinkFailed(path: String, code: Int32)
    case createParentDirectoryFailed(path: String, message: String)
    case setParentDirectoryPermissionsFailed(path: String, message: String)
    case lifecycleLockOpenFailed(path: String, code: Int32)
    case lifecycleLockInvalid(path: String)
    case lifecycleLockBusy(path: String)

    var errorDescription: String? {
        switch self {
        case let .lstatFailed(path, code):
            "lstat failed for \(path) (errno \(code))"
        case let .readlinkFailed(path, message):
            "readlink failed for \(path): \(message)"
        case let .parentPathInvalid(path, kind):
            "socket parent path invalid (\(kind)) at \(path)"
        case let .parentOwnerInvalid(path, owner, expected):
            "socket parent directory owner invalid at \(path) (uid \(owner), expected \(expected))"
        case let .parentAncestorOwnerInvalid(path, owner):
            "socket parent ancestor owner invalid at \(path) (uid \(owner))"
        case let .parentSymlinkOwnerInvalid(path, owner):
            "socket parent symlink owner invalid at \(path) (uid \(owner))"
        case let .parentPermissionsUnsafe(path, permissions):
            "socket parent directory permissions unsafe at \(path) (mode \(String(permissions, radix: 8)))"
        case let .parentACLReadFailed(path, code):
            "socket parent directory ACL read failed at \(path) (errno \(code))"
        case let .parentACLUnsafe(path):
            "socket parent directory ACL grants mutation access at \(path)"
        case let .socketPathInvalid(path, kind):
            "socket path invalid (\(kind)) at \(path)"
        case let .unlinkFailed(path, code):
            "unlink failed for \(path) (errno \(code))"
        case let .createParentDirectoryFailed(path, message):
            "socket parent directory create failed at \(path): \(message)"
        case let .setParentDirectoryPermissionsFailed(path, message):
            "socket parent directory chmod failed at \(path): \(message)"
        case let .lifecycleLockOpenFailed(path, code):
            "socket lifecycle lock open failed at \(path) (errno \(code))"
        case let .lifecycleLockInvalid(path):
            "socket lifecycle lock is unsafe at \(path)"
        case let .lifecycleLockBusy(path):
            "socket lifecycle lock is already held at \(path)"
        }
    }
}

enum ExecApprovalsSocketPathGuard {
    static let parentDirectoryPermissions = 0o700
    private static let mutatingACLPermissions: [acl_perm_t] = [
        ACL_WRITE_DATA,
        ACL_APPEND_DATA,
        ACL_DELETE_CHILD,
        ACL_DELETE,
        ACL_WRITE_ATTRIBUTES,
        ACL_WRITE_EXTATTRIBUTES,
        ACL_WRITE_SECURITY,
        ACL_CHANGE_OWNER,
    ]

    static func pathKind(at path: String) throws -> ExecApprovalsSocketPathKind {
        var status = stat()
        let result = lstat(path, &status)
        if result != 0 {
            if errno == ENOENT {
                return .missing
            }
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }

        let fileType = status.st_mode & mode_t(S_IFMT)
        if fileType == mode_t(S_IFDIR) {
            return .directory
        }
        if fileType == mode_t(S_IFSOCK) {
            return .socket
        }
        if fileType == mode_t(S_IFLNK) {
            return .symlink
        }
        return .other
    }

    static func socketIdentity(at path: String) throws -> ExecApprovalsSocketPathIdentity? {
        var status = stat()
        let result = lstat(path, &status)
        if result != 0 {
            if errno == ENOENT {
                return nil
            }
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else { return nil }
        return ExecApprovalsSocketPathIdentity(
            device: UInt64(truncatingIfNeeded: status.st_dev),
            inode: UInt64(truncatingIfNeeded: status.st_ino))
    }

    static func hardenParentDirectory(for socketPath: String) throws {
        guard socketPath.hasPrefix("/") else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: socketPath,
                kind: .other)
        }
        let lexicalComponents = (socketPath as NSString).pathComponents
        guard !lexicalComponents.contains("..") else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: socketPath,
                kind: .other)
        }
        let parentURL = URL(fileURLWithPath: socketPath)
            .deletingLastPathComponent()
            .standardized
        let parentPath = parentURL.path

        switch try self.pathKind(at: parentPath) {
        case .missing:
            let canonicalParent = try self.canonicalMissingDirectoryURL(parentURL)
            try self.createSecureDirectoryTree(at: canonicalParent)
            let verifiedParent = try self.canonicalExistingDirectoryURL(parentURL)
            guard verifiedParent.path == canonicalParent.path else {
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: parentPath,
                    kind: .symlink)
            }
            try self.validateParentDirectory(at: verifiedParent.path)
        case .directory, .symlink:
            // Validate each directory and symlink traversed by the kernel. A
            // final realpath alone hides unsafe aliases inside another alias.
            let canonicalParent = try self.canonicalExistingDirectoryURL(parentURL)
            try self.validateParentDirectory(at: canonicalParent.path)
            return
        case let kind:
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(path: parentPath, kind: kind)
        }
    }

    private static func canonicalMissingDirectoryURL(_ directory: URL) throws -> URL {
        var existingAncestor = directory
        var missingComponents: [String] = []
        while try self.pathKind(at: existingAncestor.path) == .missing {
            let component = existingAncestor.lastPathComponent
            guard !component.isEmpty, existingAncestor.path != "/" else {
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: directory.path,
                    kind: .other)
            }
            missingComponents.insert(component, at: 0)
            existingAncestor.deleteLastPathComponent()
        }
        let ancestorKind = try self.pathKind(at: existingAncestor.path)
        guard ancestorKind == .directory || ancestorKind == .symlink else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: existingAncestor.path,
                kind: ancestorKind)
        }
        var canonical = try self.canonicalExistingDirectoryURL(existingAncestor)
        for component in missingComponents {
            canonical.appendPathComponent(component, isDirectory: true)
        }
        return canonical
    }

    private static func canonicalExistingDirectoryURL(_ directory: URL) throws -> URL {
        let components = directory.standardized.pathComponents
        guard components.first == "/" else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: directory.path,
                kind: .other)
        }

        var pending = Array(components.dropFirst())
        var resolved: [String] = []
        var symlinkHops = 0
        while !pending.isEmpty {
            let component = pending.removeFirst()
            if component.isEmpty || component == "." {
                continue
            }
            if component == ".." {
                if !resolved.isEmpty {
                    resolved.removeLast()
                }
                continue
            }

            let candidate = "/" + (resolved + [component]).joined(separator: "/")
            var status = stat()
            guard lstat(candidate, &status) == 0 else {
                throw ExecApprovalsSocketPathGuardError.lstatFailed(
                    path: candidate,
                    code: errno)
            }
            let fileType = status.st_mode & mode_t(S_IFMT)
            if fileType == mode_t(S_IFLNK) {
                guard self.symlinkOwnerIsSafe(
                    owner: status.st_uid,
                    expectedOwner: geteuid())
                else {
                    throw ExecApprovalsSocketPathGuardError.parentSymlinkOwnerInvalid(
                        path: candidate,
                        owner: status.st_uid)
                }
                symlinkHops += 1
                guard symlinkHops <= Int(MAXSYMLINKS) else {
                    throw ExecApprovalsSocketPathGuardError.lstatFailed(
                        path: candidate,
                        code: ELOOP)
                }
                let destination: String
                do {
                    destination = try FileManager.default.destinationOfSymbolicLink(
                        atPath: candidate)
                } catch {
                    throw ExecApprovalsSocketPathGuardError.readlinkFailed(
                        path: candidate,
                        message: error.localizedDescription)
                }
                var destinationComponents = (destination as NSString).pathComponents
                if destination.hasPrefix("/") {
                    resolved.removeAll(keepingCapacity: true)
                    if destinationComponents.first == "/" {
                        destinationComponents.removeFirst()
                    }
                }
                pending.insert(contentsOf: destinationComponents, at: 0)
                continue
            }
            guard fileType == mode_t(S_IFDIR) else {
                let kind = try self.pathKind(at: candidate)
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: candidate,
                    kind: kind)
            }
            try self.validateAncestorDirectory(
                status: status,
                path: candidate,
                permissions: status.st_mode & mode_t(0o7777))
            resolved.append(component)
        }

        let canonicalPath = resolved.isEmpty ? "/" : "/" + resolved.joined(separator: "/")
        return URL(fileURLWithPath: canonicalPath, isDirectory: true)
    }

    private static func createSecureDirectoryTree(at directory: URL) throws {
        let components = directory.standardized.pathComponents
        guard components.first == "/" else {
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: directory.path,
                kind: .other)
        }

        var cursor = URL(fileURLWithPath: "/", isDirectory: true)
        var createdPath = false
        var createdDirectories = Set<String>()
        for component in components.dropFirst() {
            cursor.appendPathComponent(component, isDirectory: true)
            var status = stat()
            if lstat(cursor.path, &status) != 0 {
                guard errno == ENOENT else {
                    throw ExecApprovalsSocketPathGuardError.lstatFailed(
                        path: cursor.path,
                        code: errno)
                }
                if mkdir(cursor.path, mode_t(self.parentDirectoryPermissions)) == 0 {
                    createdDirectories.insert(cursor.path)
                } else if errno != EEXIST {
                    let code = errno
                    throw ExecApprovalsSocketPathGuardError.createParentDirectoryFailed(
                        path: cursor.path,
                        message: POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO).localizedDescription)
                }
                createdPath = true
                if lstat(cursor.path, &status) != 0 {
                    throw ExecApprovalsSocketPathGuardError.lstatFailed(
                        path: cursor.path,
                        code: errno)
                }
            }

            guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
                let kind = try self.pathKind(at: cursor.path)
                throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                    path: cursor.path,
                    kind: kind)
            }
            let permissions = status.st_mode & mode_t(0o7777)
            if createdPath {
                guard status.st_uid == geteuid() else {
                    throw ExecApprovalsSocketPathGuardError.parentOwnerInvalid(
                        path: cursor.path,
                        owner: status.st_uid,
                        expected: geteuid())
                }
                guard permissions & mode_t(0o022) == 0 else {
                    throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                        path: cursor.path,
                        permissions: permissions)
                }
                try self.validateDirectoryACL(at: cursor.path)
            } else {
                try self.validateAncestorDirectory(
                    status: status,
                    path: cursor.path,
                    permissions: permissions)
            }
        }

        if createdDirectories.contains(directory.path) {
            do {
                try FileManager().setAttributes(
                    [.posixPermissions: self.parentDirectoryPermissions],
                    ofItemAtPath: directory.path)
            } catch {
                throw ExecApprovalsSocketPathGuardError.setParentDirectoryPermissionsFailed(
                    path: directory.path,
                    message: error.localizedDescription)
            }
        }
        try self.validateParentDirectory(at: directory.path)
    }

    private static func validateAncestorDirectory(
        status: stat,
        path: String,
        permissions: mode_t) throws
    {
        guard self.ancestorDirectoryIsSafe(
            owner: status.st_uid,
            permissions: permissions,
            expectedOwner: geteuid())
        else {
            if status.st_uid != 0, status.st_uid != geteuid() {
                throw ExecApprovalsSocketPathGuardError.parentAncestorOwnerInvalid(
                    path: path,
                    owner: status.st_uid)
            }
            throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                path: path,
                permissions: permissions)
        }
        try self.validateDirectoryACL(at: path)
    }

    private static func validateDirectoryACL(at path: String) throws {
        errno = 0
        guard let acl = acl_get_file(path, ACL_TYPE_EXTENDED) else {
            let code = errno
            if code == ENOENT {
                return
            }
            throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                path: path,
                code: code)
        }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }

        var entry: acl_entry_t?
        var selector = ACL_FIRST_ENTRY.rawValue
        while acl_get_entry(acl, selector, &entry) == 0 {
            selector = ACL_NEXT_ENTRY.rawValue
            guard let entry else {
                throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                    path: path,
                    code: EIO)
            }
            var tag = acl_tag_t(0)
            guard acl_get_tag_type(entry, &tag) == 0 else {
                throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                    path: path,
                    code: errno == 0 ? EIO : errno)
            }
            guard tag == ACL_EXTENDED_ALLOW else {
                continue
            }
            var permissionSet: acl_permset_t?
            guard acl_get_permset(entry, &permissionSet) == 0, let permissionSet else {
                throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                    path: path,
                    code: errno == 0 ? EIO : errno)
            }
            var grantsMutation = false
            for permission in self.mutatingACLPermissions {
                let result = acl_get_perm_np(permissionSet, permission)
                guard result >= 0 else {
                    throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                        path: path,
                        code: errno == 0 ? EIO : errno)
                }
                if result != 0 {
                    grantsMutation = true
                    break
                }
            }
            guard try !grantsMutation || self.aclEntryBelongsToTrustedUser(entry, path: path) else {
                throw ExecApprovalsSocketPathGuardError.parentACLUnsafe(path: path)
            }
        }
    }

    private static func aclEntryBelongsToTrustedUser(
        _ entry: acl_entry_t,
        path: String) throws -> Bool
    {
        guard let qualifier = acl_get_qualifier(entry) else {
            throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                path: path,
                code: errno == 0 ? EIO : errno)
        }
        defer { acl_free(qualifier) }
        let entryUUID = UnsafeRawBufferPointer(start: qualifier, count: 16)

        for trustedUID in [uid_t(0), geteuid()] {
            var trustedUUID = [UInt8](repeating: 0, count: 16)
            let result = trustedUUID.withUnsafeMutableBufferPointer { buffer in
                openClawMbrUIDToUUID(trustedUID, buffer.baseAddress!)
            }
            guard result == 0 else {
                throw ExecApprovalsSocketPathGuardError.parentACLReadFailed(
                    path: path,
                    code: result)
            }
            if entryUUID.elementsEqual(trustedUUID) {
                return true
            }
        }
        return false
    }

    static func ancestorDirectoryIsSafe(
        owner: uid_t,
        permissions: mode_t,
        expectedOwner: uid_t) -> Bool
    {
        guard owner == 0 || owner == expectedOwner else { return false }
        guard permissions & mode_t(0o022) != 0 else { return true }
        return permissions & mode_t(S_ISVTX) != 0
    }

    static func symlinkOwnerIsSafe(owner: uid_t, expectedOwner: uid_t) -> Bool {
        owner == 0 || owner == expectedOwner
    }

    private static func validateParentDirectory(at path: String) throws {
        var status = stat()
        if lstat(path, &status) != 0 {
            throw ExecApprovalsSocketPathGuardError.lstatFailed(path: path, code: errno)
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
            let kind = try self.pathKind(at: path)
            throw ExecApprovalsSocketPathGuardError.parentPathInvalid(
                path: path,
                kind: kind)
        }
        let expectedOwner = geteuid()
        guard status.st_uid == expectedOwner else {
            throw ExecApprovalsSocketPathGuardError.parentOwnerInvalid(
                path: path,
                owner: status.st_uid,
                expected: expectedOwner)
        }
        let permissions = status.st_mode & mode_t(0o777)
        guard permissions & mode_t(0o022) == 0 else {
            throw ExecApprovalsSocketPathGuardError.parentPermissionsUnsafe(
                path: path,
                permissions: permissions)
        }
        try self.validateDirectoryACL(at: path)
    }

    static func removeExistingSocket(at socketPath: String) throws {
        let kind = try self.pathKind(at: socketPath)
        switch kind {
        case .missing:
            return
        case .socket:
            break
        case .directory, .symlink, .other:
            throw ExecApprovalsSocketPathGuardError.socketPathInvalid(path: socketPath, kind: kind)
        }
        if unlink(socketPath) != 0, errno != ENOENT {
            throw ExecApprovalsSocketPathGuardError.unlinkFailed(path: socketPath, code: errno)
        }
    }

    @discardableResult
    static func removeSocket(
        at socketPath: String,
        ifIdentityMatches expectedIdentity: ExecApprovalsSocketPathIdentity) throws -> Bool
    {
        guard try self.socketIdentity(at: socketPath) == expectedIdentity else { return false }
        if unlink(socketPath) != 0 {
            if errno == ENOENT {
                return false
            }
            throw ExecApprovalsSocketPathGuardError.unlinkFailed(path: socketPath, code: errno)
        }
        return true
    }
}
