import AppKit
import ComposableArchitecture
import Foundation
import Testing
@testable import PiseKit

@MainActor
struct RefreshTests {
    @Test func visibilityTracksWindowOpenCloseAndReopen() async throws {
        _ = NSApplication.shared
        var changes: [Bool] = []
        let coordinator = PopoverVisibility.Coordinator { changes.append($0) }
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        defer { coordinator.stopObserving(); window.orderOut(nil) }
        coordinator.observe(window)
        try await eventually { changes.last == false }
        window.orderFront(nil)
        try await eventually { changes.last == true }
        window.orderOut(nil)
        try await eventually { changes.last == false }
        window.orderFront(nil)
        try await eventually { changes.last == true }
        #expect(changes.filter { $0 }.count == 2)
    }

    @Test func obsoleteVisibilityNotificationsCannotReopenADismantledPopover() async throws {
        _ = NSApplication.shared
        var changes: [Bool] = []
        let coordinator = PopoverVisibility.Coordinator { changes.append($0) }
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        defer { coordinator.stopObserving(); window.orderOut(nil) }
        window.orderFront(nil)
        coordinator.observe(window) // Queue an initial true callback.
        coordinator.stopObserving() // Invalidates it before the main actor yields.
        try await Task.sleep(for: .milliseconds(30))
        #expect(changes == [false])

        coordinator.observe(window)
        window.orderOut(nil) // Also supersede a queued true within one generation.
        try await Task.sleep(for: .milliseconds(30))
        #expect(changes.allSatisfy { !$0 })
    }

    @Test func liveClientEmitsAPostSubscriptionReloadSignal() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = LedgerPaths(usage: directory.appending(path: "usage.jsonl"), skills: directory.appending(path: "skills.jsonl"))
        let line = try LedgerFixtures.line(LedgerFixtures.usage(timestamp: Date()))
        try line.write(to: paths.usage)
        let client = LedgerClient.live(paths: paths)
        let beforeSubscription = try await client.report(ReportQuery(), true)
        #expect(beforeSubscription.totals.calls == 1)
        // This write has no watcher yet and must be caught by the initial signal.
        try (line + line).write(to: paths.usage, options: .atomic)
        let changes = await client.changes()
        let signals = AsyncStream.makeStream(of: Bool.self)
        let observer = Task { @concurrent in
            for await _ in changes { signals.continuation.yield(true) }
        }
        defer { observer.cancel() }
        var iterator = signals.stream.makeAsyncIterator()
        #expect(await iterator.next() == true)
        let afterSubscription = try await client.report(ReportQuery(), true)
        #expect(afterSubscription.totals.calls == 2)
        observer.cancel()
        await observer.value
    }

    @Test func watcherObservesAppendRecreationAndStopsWhenClosed() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = LedgerPaths(usage: directory.appending(path: "usage/ledger.jsonl"),
                                skills: directory.appending(path: "skills/ledger.jsonl"))
        let watcher = LedgerWatcher(paths: paths)
        var events = 0
        watcher.onChange = { events += 1 }
        watcher.start()
        defer { watcher.stop() }
        try FileManager.default.createDirectory(at: paths.usage.deletingLastPathComponent(), withIntermediateDirectories: true)
        try await eventually { events > 0 }
        watcher.start()
        events = 0
        try LedgerFixtures.line(LedgerFixtures.usage()).write(to: paths.usage)
        try await eventually { events > 0 }
        watcher.start()
        events = 0
        let handle = try FileHandle(forWritingTo: paths.usage)
        try handle.seekToEnd()
        try handle.write(contentsOf: LedgerFixtures.line(LedgerFixtures.usage(id: "u2")))
        try handle.close()
        try await eventually { events > 0 }
        try FileManager.default.removeItem(at: paths.usage)
        watcher.start()
        events = 0
        try LedgerFixtures.line(LedgerFixtures.usage(id: "replacement")).write(to: paths.usage, options: .atomic)
        try await eventually { events > 0 }
        watcher.stop()
        // Drain already-delivered handler tasks before establishing the baseline.
        try await Task.sleep(for: .milliseconds(100))
        let baseline = events
        try Data().write(to: paths.usage)
        try await Task.sleep(for: .milliseconds(100))
        #expect(events == baseline)
    }

    @Test func storeReopensWithFreshDataAndClearsUsageFiltersOnProjectChange() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = LedgerPaths(usage: directory.appending(path: "usage.jsonl"), skills: directory.appending(path: "skills.jsonl"))
        let store = makeStore(paths: paths)
        store.send(.visibilityChanged(true))
        try await eventually { store.report.loadedAt != nil && !store.loading }
        #expect(store.report.usageStatus.missing)
        store.send(.visibilityChanged(false))
        try LedgerFixtures.line(LedgerFixtures.usage(timestamp: Date())).write(to: paths.usage)
        store.send(.visibilityChanged(true))
        defer { store.send(.visibilityChanged(false)) }
        try await eventually { !store.loading && store.report.totals.calls == 1 }
        store.send(.binding(.set(\.query.model, "old-model")))
        store.send(.binding(.set(\.query.branch, "old-branch")))
        store.send(.binding(.set(\.query.tag, "old-tag")))
        store.send(.projectSelected("github.com/example/project"))
        #expect(!store.query.hasUsageFilters)
        store.send(.clearFiltersTapped)
        #expect(!store.query.hasFilters)
    }

    @Test func productionStoreRearmsAfterDeletionAndAtomicReplacement() async throws {
        let directory = try LedgerFixtures.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let paths = LedgerPaths(usage: directory.appending(path: "usage/ledger.jsonl"), skills: directory.appending(path: "skills/ledger.jsonl"))
        let store = makeStore(paths: paths)
        store.send(.visibilityChanged(true))
        defer { store.send(.visibilityChanged(false)) }
        try await eventually { !store.loading && store.report.loadedAt != nil }
        try FileManager.default.createDirectory(at: paths.usage.deletingLastPathComponent(), withIntermediateDirectories: true)
        try LedgerFixtures.line(LedgerFixtures.usage(timestamp: Date())).write(to: paths.usage)
        try await eventually { store.report.totals.calls == 1 && !store.loading }
        try FileManager.default.removeItem(at: paths.usage)
        try await eventually { store.report.usageStatus.missing && !store.loading }
        let replacement = try LedgerFixtures.line(LedgerFixtures.usage(timestamp: Date(), tokens: 999))
        try replacement.write(to: paths.usage, options: .atomic)
        try await eventually { store.report.totals.tokens == 999 && !store.loading }
        try (replacement + replacement).write(to: paths.usage, options: .atomic)
        try await eventually { store.report.totals.calls == 2 && !store.loading }
    }

    private func makeStore(paths: LedgerPaths) -> StoreOf<DashboardFeature> {
        Store(initialState: DashboardFeature.State()) {
            DashboardFeature()
        } withDependencies: {
            $0.ledgerClient = .live(paths: paths)
            $0.continuousClock = ContinuousClock()
        }
    }

    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<150 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("Timed out waiting for visibility/file event")
    }
}
