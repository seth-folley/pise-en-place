import SwiftUI

extension UsageMetric {
    func formatted(_ totals: UsageTotals) -> String {
        switch self {
        case .cost:
            guard let amount = totals.estimatedCost else { return "—" }
            return Self.money(amount) + (totals.costedCalls < totals.calls ? "*" : "")
        case .tokens: return Self.number(totals.tokens)
        }
    }

    func accessibleValue(_ totals: UsageTotals) -> String {
        if self == .cost {
            guard let amount = totals.estimatedCost else { return "Cost unavailable" }
            let coverage = totals.costedCalls < totals.calls ? ", partial: estimates for \(totals.costedCalls) of \(totals.calls) responses" : ""
            return Self.money(amount) + coverage
        }
        return formatted(totals)
    }

    static func money(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2...4)))
    }

    static func number(_ value: Double) -> String {
        value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title2.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

struct LedgerNotices: View {
    let title: String
    let status: LedgerStatus
    var body: some View {
        ForEach(status.notices, id: \.self) { notice in
            Label("\(title): \(notice)", systemImage: status.error == nil ? "info.circle" : "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(status.error == nil ? Color.secondary : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct UsageRanking: View {
    let title: String
    let rows: [UsageRow]
    let metric: UsageMetric
    var selection: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            if rows.isEmpty {
                Text("No recorded activity for these filters.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                if let selection {
                    Button { selection(row.id) } label: { rowContent(row) }
                        .buttonStyle(.plain)
                        .help(row.id)
                        .accessibilityHint("Filter by \(row.label)")
                } else { rowContent(row).help(row.id) }
            }
        }
    }

    private func rowContent(_ row: UsageRow) -> some View {
        VStack(spacing: 4) {
            HStack {
                Text(row.label).lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(metric.formatted(row.totals)).monospacedDigit()
                if selection != nil { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary) }
            }
            let maximum = rows.map { metric.value($0.totals) }.max() ?? 0
            ProgressView(value: maximum > 0 ? metric.value(row.totals) / maximum : 0)
                .accessibilityHidden(true)
            if metric == .cost && row.totals.costedCalls < row.totals.calls {
                Text("Estimates for \(row.totals.costedCalls)/\(row.totals.calls) responses")
                    .font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.label)
        .accessibilityValue(metric.accessibleValue(row.totals))
    }
}
