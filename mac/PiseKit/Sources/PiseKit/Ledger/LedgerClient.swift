import ComposableArchitecture
import Foundation

// Dependencies exchange only Sendable values. Each live client owns one reader;
// each changes subscription owns a watcher, whose lifetime follows the effect.
struct LedgerClient: Sendable {
    var report: @Sendable (ReportQuery, Bool) async throws -> DashboardReport
    var changes: @Sendable () async -> AsyncStream<Void>

    static func live(paths: LedgerPaths) -> Self {
        let reader = LedgerReader(paths: paths)
        return Self(
            report: { query, reload in try await reader.report(query: query, reload: reload) },
            changes: { await watch(paths: paths) }
        )
    }

    @MainActor private static func watch(paths: LedgerPaths) -> AsyncStream<Void> {
        let watcher = LedgerWatcher(paths: paths)
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            watcher.onChange = { [weak watcher] in
                // Rebind descriptors immediately so directory creation, deletion,
                // and atomic replacement cannot strand the subscription.
                watcher?.start()
                continuation.yield(())
            }
            continuation.onTermination = { _ in
                Task { @MainActor in
                    watcher.onChange = nil
                    watcher.stop()
                }
            }
            watcher.start()
            // Opening starts report and subscription effects concurrently. Force
            // one post-subscription reload so a write in that setup gap cannot
            // leave the cached snapshot stale for the rest of the open session.
            continuation.yield(())
        }
    }
}

extension LedgerClient: DependencyKey {
    static let liveValue = live(paths: .live)
    static let testValue = Self(
        report: { _, _ in
            reportIssue("LedgerClient.report must be overridden in tests")
            return DashboardReport()
        },
        changes: {
            reportIssue("LedgerClient.changes must be overridden in tests")
            return AsyncStream { $0.finish() }
        }
    )
    static let previewValue = testValue
}

extension DependencyValues {
    var ledgerClient: LedgerClient {
        get { self[LedgerClient.self] }
        set { self[LedgerClient.self] = newValue }
    }
}
