// SmtpEmailSink — one of two configurable real terminal-action sinks.
//
// JsonlLedgerSink is the other durable transport; payment-rail and specialist-review
// adapters remain inspectable in-memory simulations. This sink is real: once a human approves a `draft_vendor_reply`, the agent's
// approved arguments are handed to a real SMTP transport. A successful `sendMail`
// proves transport acceptance/submission, not recipient delivery. Nothing about the human-in-the-loop gate changes — `send()` is still
// only ever reached from a tool `execute()`, which only runs from `AutopilotAgent`'s
// `approve()` / `amend()` chokepoint. The model can never reach this code; a person
// must approve first, and the EXACT approved args are what get sent.
//
// Two modes, chosen by environment, so it is safe everywhere:
//   • REAL     — `SMTP_HOST` is set → a nodemailer transport is built and the message
//                is submitted to it. A transport error PROPAGATES (it is awaited),
//                so a failed send leaves the work item `executing` for explicit
//                reconciliation; it is never automatically retried.
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
    messageId?: string;
  }): Promise<{ messageId?: string }>;
}

// Remove CR, LF and other C0/C1 control characters from an email HEADER field value.
// SMTP headers are line-delimited, so an embedded CRLF in `to`/`subject` would let an
// approved string inject an additional header (e.g. a hidden Bcc). Stripping the
// control bytes neutralizes that; ordinary header text (which never contains control
// characters) is returned unchanged, byte-for-byte — so the sanitizer is a strict no-op
// on legitimate values.
export function stripHeaderChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, "");
}

export interface SmtpSinkOptions {
  // The envelope From address (SMTP_FROM). Required — a real MTA rejects a blank From.
  from: string;
  // The transport to submit through. Absent → SIMULATE mode (record + log, no send).
  transport?: MailTransport;
  // Injectable logger (defaults to console) so tests can assert the simulate/submit
  // log lines without stdout noise.
  logger?: Pick<typeof console, "log" | "warn">;
}

export class SmtpEmailSink implements EmailSink {
  private rows: OutboundEmail[] = [];
  private completedRefs = new Set<string>();
  private readonly from: string;
  private readonly transport?: MailTransport;
  private readonly logger: Pick<typeof console, "log" | "warn">;

  constructor(opts: SmtpSinkOptions) {
    const from = opts.from.trim();
    if (!from || /[\r\n\0]/.test(from)) {
      throw new Error("invalid SMTP configuration: from must be a safe non-empty header value");
    }
    this.from = from;
    this.transport = opts.transport;
    this.logger = opts.logger ?? console;
  }

  // True when a real transport is wired — i.e. an approval submits mail to SMTP.
  get live(): boolean {
    return this.transport !== undefined;
  }

  async send(email: Omit<OutboundEmail, "sentAt">): Promise<OutboundEmail> {
    if (email.ref && this.completedRefs.has(email.ref)) {
      return this.rows.find((r) => r.ref === email.ref)!;
    }
    const row: OutboundEmail = { ...email, sentAt: new Date().toISOString() };
    // Record the intent FIRST so the outbox reflects what a human approved even if the
    // network submission below throws (the caller sees an uncertain outcome to reconcile).
    this.rows.push(row);

    if (!this.transport) {
      // SIMULATE — no creds/transport. Nothing is sent; the outbox holds the record.
      this.logger.log(
        `[SmtpEmailSink] SIMULATED (no SMTP transport configured) — approved message${row.ref ? ` ref ${row.ref}` : ""} was not sent`
      );
      if (row.ref) this.completedRefs.add(row.ref);
      return row;
    }

    // REAL transport submission. Awaited on purpose: a failure propagates to approve()/amend() and
    // leaves the item executing for reconciliation rather than claiming success.
    // Defense-in-depth: the header fields (`to`, `subject`) are stripped of CR/LF and
    // other control characters before they reach the transport, so an approved value
    // like "Invoice\r\nBcc: attacker@evil" cannot smuggle an extra SMTP header (CRLF
    // header injection). A real nodemailer transport already rejects such headers; this
    // makes the sink safe regardless of the transport behind the seam. Clean values pass
    // through byte-for-byte, and the body (`text`) is NOT a header, so its newlines are
    // preserved verbatim.
    const message: Parameters<MailTransport["sendMail"]>[0] = {
      from: this.from,
      to: stripHeaderChars(row.to),
      subject: stripHeaderChars(row.subject),
      text: row.body,
    };
    // Stable across a manually-authorized retry; many mail systems use this
    // standard id as an additional duplicate-delivery signal. This protects the
    // application intent but SMTP cannot promise exactly-once recipient delivery.
    // Omit the optional
    // field entirely when no execution key exists so direct sink callers retain
    // an exact transport payload.
    if (row.ref) message.messageId = `<${row.ref}@archon-autopilot>`;
    const info = await this.transport.sendMail(message);
    if (row.ref) this.completedRefs.add(row.ref);
    this.logger.log(
      `[SmtpEmailSink] SMTP transport accepted approved message${row.ref ? ` ref ${row.ref}` : ""}${info.messageId ? ` (transport id ${info.messageId})` : ""}`
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
    const anySmtpSetting = [
      env.SMTP_HOST,
      env.SMTP_PORT,
      env.SMTP_SECURE,
      env.SMTP_USER,
      env.SMTP_PASS,
      env.SMTP_FROM,
      env.SMTP_CONNECTION_TIMEOUT_MS,
      env.SMTP_GREETING_TIMEOUT_MS,
      env.SMTP_SOCKET_TIMEOUT_MS,
    ].some((value) => value != null && value.trim() !== "");
    if (!host) {
      if (anySmtpSetting) throw new Error("invalid SMTP configuration: SMTP_HOST is required when SMTP is configured");
      return null;
    }
    if (/\s|[\r\n\0]/.test(host)) throw new Error("invalid SMTP configuration: SMTP_HOST is malformed");
    const from = (env.SMTP_FROM || env.SMTP_USER || "").trim();
    if (!from || /[\r\n\0]/.test(from)) {
      throw new Error("invalid SMTP configuration: a safe non-empty SMTP_FROM (or SMTP_USER fallback) is required");
    }
    const user = env.SMTP_USER?.trim() || undefined;
    const pass = env.SMTP_PASS && env.SMTP_PASS.length > 0 ? env.SMTP_PASS : undefined;
    if (Boolean(user) !== Boolean(pass)) {
      throw new Error("invalid SMTP configuration: SMTP_USER and SMTP_PASS must be supplied together");
    }
    const rawPort = env.SMTP_PORT?.trim() || "587";
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("invalid SMTP configuration: SMTP_PORT must be an integer from 1 to 65535");
    }
    const rawSecure = env.SMTP_SECURE?.trim();
    if (rawSecure && !/^(0|1|false|true|no|yes)$/i.test(rawSecure)) {
      throw new Error("invalid SMTP configuration: SMTP_SECURE must be true/false, yes/no, or 1/0");
    }
    const transport = createSmtpTransport({
      host,
      port,
      secure: /^(1|true|yes)$/i.test(rawSecure || ""),
      user,
      pass,
      connectionTimeout: boundedEnvInt(env.SMTP_CONNECTION_TIMEOUT_MS, 10_000, 1_000, 30_000),
      greetingTimeout: boundedEnvInt(env.SMTP_GREETING_TIMEOUT_MS, 10_000, 1_000, 30_000),
      socketTimeout: boundedEnvInt(env.SMTP_SOCKET_TIMEOUT_MS, 30_000, 1_000, 60_000),
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
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
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
    connectionTimeout: cfg.connectionTimeout,
    greetingTimeout: cfg.greetingTimeout,
    socketTimeout: cfg.socketTimeout,
  });
  return { sendMail: (message) => transporter.sendMail(message) };
}
/* c8 ignore stop */

function boundedEnvInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
