import Darwin
import Foundation

enum ElevationExclusiveRename {
    static let argument = "--elevation-rename-exclusive"

    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        guard arguments.dropFirst().first == self.argument else { return nil }
        guard arguments.count == 4 else {
            fputs("OpenClaw elevation rename requires absolute source and destination paths\n", stderr)
            return 2
        }
        let source = arguments[2]
        let destination = arguments[3]
        guard source.hasPrefix("/"), destination.hasPrefix("/") else {
            fputs("OpenClaw elevation rename paths must be absolute\n", stderr)
            return 2
        }

        let result = source.withCString { sourcePath in
            destination.withCString { destinationPath in
                renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        guard result == 0 else {
            let code = errno
            fputs("OpenClaw elevation rename failed: \(String(cString: strerror(code)))\n", stderr)
            return 1
        }
        return 0
    }
}

enum ElevationFilesystemSync {
    static let fileArgument = "--elevation-sync-file"
    static let directoryArgument = "--elevation-sync-directory"
    static let treeArgument = "--elevation-sync-tree"

    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        guard let argument = arguments.dropFirst().first,
              argument == self.fileArgument || argument == self.directoryArgument || argument == self.treeArgument
        else { return nil }
        guard arguments.count == 3 else {
            fputs("OpenClaw elevation sync requires one absolute path\n", stderr)
            return 2
        }
        let path = arguments[2]
        guard path.hasPrefix("/") else {
            fputs("OpenClaw elevation sync path must be absolute\n", stderr)
            return 2
        }
        if argument == self.treeArgument {
            return self.syncTree(path) ? 0 : 1
        }
        let expectsDirectory = argument == self.directoryArgument
        return self.syncPath(path, expectsDirectory: expectsDirectory) ? 0 : 1
    }

    private static func syncPath(_ path: String, expectsDirectory: Bool) -> Bool {
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | (expectsDirectory ? O_DIRECTORY : 0))
        guard descriptor >= 0 else {
            fputs("OpenClaw elevation sync could not open path\n", stderr)
            return false
        }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              expectsDirectory ? (metadata.st_mode & S_IFMT) == S_IFDIR : (metadata.st_mode & S_IFMT) == S_IFREG
        else {
            fputs("OpenClaw elevation sync path has an unsupported type\n", stderr)
            return false
        }
        if expectsDirectory {
            guard fsync(descriptor) == 0 else {
                fputs("OpenClaw elevation directory sync failed\n", stderr)
                return false
            }
            return true
        }
        guard fcntl(descriptor, F_FULLFSYNC) == 0 || fsync(descriptor) == 0 else {
            fputs("OpenClaw elevation file sync failed\n", stderr)
            return false
        }
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        let parentDescriptor = open(parent, O_RDONLY | O_NOFOLLOW | O_DIRECTORY)
        guard parentDescriptor >= 0 else {
            fputs("OpenClaw elevation sync could not open parent directory\n", stderr)
            return false
        }
        defer { close(parentDescriptor) }
        guard fsync(parentDescriptor) == 0 else {
            fputs("OpenClaw elevation parent directory sync failed\n", stderr)
            return false
        }
        return true
    }

    private static func syncTree(_ path: String) -> Bool {
        let root = URL(fileURLWithPath: path, isDirectory: true)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        var enumerationFailed = false
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: [],
            errorHandler: { _, _ in
                enumerationFailed = true
                return false
            })
        else {
            fputs("OpenClaw elevation sync could not enumerate tree\n", stderr)
            return false
        }
        var directories = [root]
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else {
                fputs("OpenClaw elevation sync could not inspect tree entry\n", stderr)
                return false
            }
            if values.isSymbolicLink == true {
                continue
            }
            if values.isDirectory == true {
                directories.append(url)
            } else if values.isRegularFile == true {
                guard self.syncPath(url.path, expectsDirectory: false) else { return false }
            } else {
                fputs("OpenClaw elevation sync tree contains an unsupported entry\n", stderr)
                return false
            }
        }
        guard !enumerationFailed else {
            fputs("OpenClaw elevation sync could not enumerate complete tree\n", stderr)
            return false
        }
        for directory in directories.reversed() {
            guard self.syncPath(directory.path, expectsDirectory: true) else { return false }
        }
        return true
    }
}

struct AppLaunchRuntimePlan: Equatable {
    enum Mode: Equatable {
        case interactive
        case background
        case elevationHost
    }

    let mode: Mode
    let attachOnly: Bool

    init(arguments: [String]) {
        if arguments.contains("--elevation-host") {
            self.mode = .elevationHost
            self.attachOnly = true
        } else {
            self.mode = arguments.contains("--background-only") ? .background : .interactive
            self.attachOnly = arguments.contains("--attach-only") || arguments.contains("--no-launchd")
        }
    }

    static var current: Self {
        Self(arguments: CommandLine.arguments)
    }

    var isElevationHost: Bool {
        self.mode == .elevationHost
    }

    var allowsAutomaticPresentation: Bool {
        self.mode == .interactive
    }

    /// GUI-owned Keychain items may present SecurityAgent when a newly signed build is not in an item's ACL.
    /// Background hosts keep that state cold; config and environment still own their primary Gateway route.
    var allowsGatewayUIKeychainAccess: Bool {
        self.mode == .interactive
    }

    var allowsUpdater: Bool {
        !self.isElevationHost
    }

    var allowsDockIcon: Bool {
        !self.isElevationHost
    }

    var allowsInteractiveServices: Bool {
        !self.isElevationHost
    }

    var allowsCuaComputerControl: Bool {
        !self.isElevationHost
    }

    func shouldAutoOpenChat(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation &&
            (arguments.contains("--chat") || arguments.contains("--webchat"))
    }

    func shouldAutoOpenDashboard(arguments: [String]) -> Bool {
        self.allowsAutomaticPresentation && arguments.contains("--dashboard")
    }
}
