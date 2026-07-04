// Side-effect sinks — the world the autopilot acts on once a human approves.
//
// Executing an AP action has real consequences: a journal entry is posted to the
// ledger, a payment is recorded, a reply is sent to the vendor, a review is
// escalated. In this vertical slice those are STUB sinks that record what would
// happen (in-memory, inspectable) rather than touching a real ERP / bank / SMTP.
// Swapping in a real ledger client, payment rail, or SMTP transport later is a
// drop-in replacement behind these interfaces — the workflow code is unchanged.

export interface LedgerEntry {
  ref: string;
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

// The transport the autopilot "sends" vendor replies through.
export interface EmailSink {
  send(email: Omit<OutboundEmail, "sentAt">): OutboundEmail;
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
  send(email: Omit<OutboundEmail, "sentAt">): OutboundEmail {
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
