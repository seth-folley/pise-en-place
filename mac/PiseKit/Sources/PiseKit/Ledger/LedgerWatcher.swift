import Foundation
import Darwin

// File descriptors are read/event-only. Both files and their nearest existing
// parent directories are watched: append, replacement, deletion, and first-time
// creation all trigger a debounced rescan. No timer polls the filesystem.
@MainActor
final class LedgerWatcher {
    private let paths: LedgerPaths
    private var sources: [any DispatchSourceFileSystemObject] = []
    var onChange: (@MainActor @Sendable () -> Void)?

    init(paths: LedgerPaths = .live) { self.paths = paths }

    func start() {
        stop()
        var targets: Set<String> = []
        for url in [paths.usage, paths.skills] {
            if FileManager.default.fileExists(atPath: url.path) { targets.insert(url.path) }
            var directory = url.deletingLastPathComponent()
            while !FileManager.default.fileExists(atPath: directory.path), directory.path != "/" {
                directory.deleteLastPathComponent()
            }
            targets.insert(directory.path)
        }
        for path in targets {
            let descriptor = open(path, O_EVTONLY)
            guard descriptor >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: descriptor, eventMask: [.write, .extend, .delete, .rename, .attrib, .revoke], queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in self?.onChange?() }
            }
            source.setCancelHandler { close(descriptor) }
            sources.append(source)
            source.resume()
        }
    }

    func stop() {
        for source in sources { source.cancel() }
        sources.removeAll()
    }
}
