// Side-effect sinks — the world the autopilot acts on once a human approves.
//
// Executing an AP action has real consequences: a journal entry is posted to the
// ledger, a payment is recorded, a reply is sent to the vendor, a review is
// escalated. The defaults here are inspectable in-memory Fakes for offline tests.
// Production can replace the ledger with the durable, fsynced `JsonlLedgerSink`
// and email with the real `SmtpEmailSink`; payment-rail and specialist-review
// remain simulated adapters. Every implementation stays behind the same human gate.
//
// `EmailSink.send` is async because the real transport performs network I/O; the
// awaited result surfaces a delivery FAILURE back at the approval call, so a failed
// send leaves the work item in an explicit uncertain/executing state for operator
// reconciliation rather than being silently swallowed or automatically retried.
// The other three sinks stay synchronous (pure in-memory record).

export interface LedgerEntry {
  ref: string;
  currency: string;
  narrative: string;
  lines: Array<{ account: string; debit?: number; credit?: number }>;
  postedAt: string;
}

export interface PaymentRecord {
  ref: string;
  vendor: string;
  amount: number;
  currency: string;
  scheduledFor: string | null;
  recordedAt: string;
}

export interface OutboundEmail {
  // Deterministic work-item execution key. Optional only for backwards-
  // compatible direct sink use; terminal tools always provide it.
  ref?: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

export interface ReviewEscalation {
  ref: string;
  reason: string;
  priority: "low" | "normal" | "high";
  raisedAt: string;
}

// The ledger the autopilot posts journal entries to.
export interface LedgerSink {
  post(entry: Omit<LedgerEntry, "postedAt">): LedgerEntry;
  entries(): LedgerEntry[];
}

// The payment rail the autopilot records payments on.
export interface PaymentSink {
  record(payment: Omit<PaymentRecord, "recordedAt">): PaymentRecord;
  payments(): PaymentRecord[];
}

// The transport the autopilot sends vendor replies through. Async because a real
// SMTP transport (SmtpEmailSink) performs network I/O; the Fake resolves immediately.
export interface EmailSink {
  send(email: Omit<OutboundEmail, "sentAt">): Promise<OutboundEmail>;
  outbox(): OutboundEmail[];
}

// The queue human reviewers pick escalations up from.
export interface ReviewSink {
  raise(item: Omit<ReviewEscalation, "raisedAt">): ReviewEscalation;
  escalations(): ReviewEscalation[];
}

export interface Sinks {
  ledger: LedgerSink;
  payments: PaymentSink;
  email: EmailSink;
  reviews: ReviewSink;
}

// ── Deterministic in-memory Fakes (dev + CI + tests) ──────────────────────────

export class FakeLedgerSink implements LedgerSink {
  private rows: LedgerEntry[] = [];
  post(entry: Omit<LedgerEntry, "postedAt">): LedgerEntry {
    const existing = this.rows.find((r) => r.ref === entry.ref);
    if (existing) return existing;
    const row = { ...entry, postedAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }
  entries(): LedgerEntry[] {
    return this.rows;
  }
}

export class FakePaymentSink implements PaymentSink {
  private rows: PaymentRecord[] = [];
  record(payment: Omit<PaymentRecord, "recordedAt">): PaymentRecord {
    const existing = this.rows.find((r) => r.ref === payment.ref);
    if (existing) return existing;
    const row = { ...payment, recordedAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }
  payments(): PaymentRecord[] {
    return this.rows;
  }
}

export class FakeEmailSink implements EmailSink {
  private rows: OutboundEmail[] = [];
  async send(email: Omit<OutboundEmail, "sentAt">): Promise<OutboundEmail> {
    const existing = email.ref ? this.rows.find((r) => r.ref === email.ref) : undefined;
    if (existing) return existing;
    const row = { ...email, sentAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }
  outbox(): OutboundEmail[] {
    return this.rows;
  }
}

export class FakeReviewSink implements ReviewSink {
  private rows: ReviewEscalation[] = [];
  raise(item: Omit<ReviewEscalation, "raisedAt">): ReviewEscalation {
    const existing = this.rows.find((r) => r.ref === item.ref);
    if (existing) return existing;
    const row = { ...item, raisedAt: new Date().toISOString() };
    this.rows.push(row);
    return row;
  }
  escalations(): ReviewEscalation[] {
    return this.rows;
  }
}

// A fresh set of offline Fake sinks — one bundle per server/agent instance.
export function fakeSinks(): Sinks {
  return {
    ledger: new FakeLedgerSink(),
    payments: new FakePaymentSink(),
    email: new FakeEmailSink(),
    reviews: new FakeReviewSink(),
  };
}
