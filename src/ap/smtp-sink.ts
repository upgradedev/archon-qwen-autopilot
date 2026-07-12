// SmtpEmailSink — the ONE real terminal-action sink.
//
// Every other side-effect sink (ledger / payment-rail / reviews) is an in-memory
// Fake. This one is real: once a human approves a `draft_vendor_reply`, the agent's
// approved arguments are handed to a real SMTP transport and an actual email is
// delivered. Nothing about the human-in-the-loop gate changes — `send()` is still
// only ever reached from a tool `execute()`, which only runs from `AutopilotAgent`'s
// `approve()` / `amend()` chokepoint. The model can never reach this code; a person
// must approve first, and the EXACT approved args are what get sent.
//
// Two modes, chosen by environment, so it is safe everywhere:
//   • REAL     — `SMTP_HOST` is set → a nodemailer transport is built and the message
//                is actually delivered. A delivery error PROPAGATES (it is awaited),
//                so a failed send surfaces at the approval call and the work item
//                stays pending for retry instead of being silently lost.
//   • SIMULATE — no transport (no creds / CI / tests without a mock) → the message is
//                recorded to the inspectable outbox and logged as "simulated", and
//                NOTHING is sent. This is the clean no-op the offline path relies on.
//
// The transport is an injectable seam (`MailTransport`) so tests drive it with a mock
// and never touch the network, and the single real-network line
// (`nodemailer.createTransport`) is isolated in one factory.

import { createRequire } from "node:module";
import type { EmailSink, OutboundEmail } from "./sinks.js";

// The minimal transport contract the sink needs — a structural subset of nodemailer's
// `Transporter`, so a real nodemailer transport satisfies it directly and a test can
// supply a tiny mock. Kept narrow on purpose: the sink depends on this, not on SMTP.
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

export interface SmtpSinkOptions {
  // The envelope From address (SMTP_FROM). Required — a real MTA rejects a blank From.
  from: string;
  // The transport to deliver through. Absent → SIMULATE mode (record + log, no send).
  transport?: MailTransport;
  // Injectable logger (defaults to console) so tests can assert the simulate/deliver
  // log lines without stdout noise.
  logger?: Pick<typeof console, "log" | "warn">;
}

export class SmtpEmailSink implements EmailSink {
  private rows: OutboundEmail[] = [];
  private readonly from: string;
  private readonly transport?: MailTransport;
  private readonly logger: Pick<typeof console, "log" | "warn">;

  constructor(opts: SmtpSinkOptions) {
    this.from = opts.from;
    this.transport = opts.transport;
    this.logger = opts.logger ?? console;
  }

  // True when a real transport is wired — i.e. an approval will actually deliver mail.
  get live(): boolean {
    return this.transport !== undefined;
  }

  async send(email: Omit<OutboundEmail, "sentAt">): Promise<OutboundEmail> {
    const row: OutboundEmail = { ...email, sentAt: new Date().toISOString() };
    // Record the intent FIRST so the outbox reflects what a human approved even if the
    // network delivery below throws (the caller sees the failure and can retry).
    this.rows.push(row);

    if (!this.transport) {
      // SIMULATE — no creds/transport. Nothing is sent; the outbox holds the record.
      this.logger.log(
        `[SmtpEmailSink] SIMULATED (no SMTP transport configured) — would send to ${row.to}: "${row.subject}"`
      );
      return row;
    }

    // REAL delivery. Awaited on purpose: a failure propagates to approve()/amend() so
    // the work item stays pending rather than being marked approved with no email sent.
    const info = await this.transport.sendMail({
      from: this.from,
      to: row.to,
      subject: row.subject,
      text: row.body,
    });
    this.logger.log(
      `[SmtpEmailSink] delivered to ${row.to}: "${row.subject}"${info.messageId ? ` (id ${info.messageId})` : ""}`
    );
    return row;
  }

  outbox(): OutboundEmail[] {
    return this.rows;
  }

  // Build the env-configured sink, or `null` when SMTP is not configured (so the
  // caller falls back to the in-memory Fake). A real nodemailer transport is created
  // only when SMTP_HOST is present; SMTP_USER/SMTP_PASS enable auth when both are set.
  //   SMTP_HOST · SMTP_PORT (default 587) · SMTP_SECURE (true→465/TLS) ·
  //   SMTP_USER · SMTP_PASS · SMTP_FROM (default SMTP_USER)
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SmtpEmailSink | null {
    const host = env.SMTP_HOST?.trim();
    if (!host) return null;
    const from = (env.SMTP_FROM || env.SMTP_USER || "").trim();
    const transport = createSmtpTransport({
      host,
      port: Number(env.SMTP_PORT || 587),
      secure: /^(1|true|yes)$/i.test(env.SMTP_SECURE || ""),
      user: env.SMTP_USER?.trim(),
      pass: env.SMTP_PASS,
    });
    return new SmtpEmailSink({ from, transport });
  }
}

// The single real-network seam: turn SMTP settings into a nodemailer transport. The
// `nodemailer` import is dynamic + the createTransport line c8-ignored because it can
// only run with real infrastructure; every other line in this module is unit-tested
// through an injected mock MailTransport.
/* c8 ignore start */
function createSmtpTransport(cfg: {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}): MailTransport {
  // Deferred require keeps nodemailer off the hot path for the offline Fake sink and
  // means the optional dependency only needs to resolve when SMTP is actually
  // configured (ESM has no bare `require`, so build one bound to this module URL).
  const req = createRequire(import.meta.url);
  const nodemailer = req("nodemailer") as typeof import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return { sendMail: (message) => transporter.sendMail(message) };
}
/* c8 ignore stop */
