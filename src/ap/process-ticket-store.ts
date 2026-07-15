// Durable entitlement joining the two-step document flow:
//   extract (which spends quota) -> human review -> decision loop (which must not).
//
// A ticket is owner/tier/day bound and source-digest bound when issued. Claims are
// leases: a proposal completes and
// consumes the ticket, while a pre-proposal failure releases it for a same-digest
// retry. The Postgres implementation makes this contract survive replicas/restarts;
// the in-memory implementation is the deterministic offline/test seam.

import { createHash, randomUUID } from "node:crypto";
import { withClient } from "../db/client.js";

export type ProcessTicketTier = "public" | "reviewer";

export interface ProcessTicketIdentity {
  tier: ProcessTicketTier;
  bindingHash: string;
  day: string;
}

export interface ProcessTicketIssueOptions {
  now: Date;
  ttlMs: number;
  cap: number;
  sourceDigest: string;
}

export interface ProcessTicketClaimOptions {
  now: Date;
  staleAfterMs: number;
}

export type ProcessTicketClaim =
  | { status: "claimed"; claimId: string }
  | { status: "busy" }
  | { status: "invalid" };

export interface ProcessTicketGrant {
  ticket: string;
  extractionId: string;
}

export class ProcessTicketCapacityError extends Error {
  constructor() {
    super("all bounded process-ticket slots are actively claimed");
    this.name = "ProcessTicketCapacityError";
  }
}

export interface ProcessTicketStore {
  issue(identity: ProcessTicketIdentity, options: ProcessTicketIssueOptions): Promise<ProcessTicketGrant>;
  claim(
    ticket: string,
    identity: ProcessTicketIdentity,
    invoiceDigest: string,
    options: ProcessTicketClaimOptions
  ): Promise<ProcessTicketClaim>;
  release(ticket: string, claimId: string): Promise<boolean>;
  complete(ticket: string, claimId: string, now?: Date): Promise<boolean>;
}

interface MemoryTicket extends ProcessTicketIdentity {
  ticket: string;
  extractionId: string;
  expiresAt: number;
  createdAt: number;
  sourceDigest: string;
  reviewedDigest: string | null;
  claimId: string | null;
  claimedAt: number | null;
  consumedAt: number | null;
}

export class InMemoryProcessTicketStore implements ProcessTicketStore {
  private readonly rows = new Map<string, MemoryTicket>();

  async issue(identity: ProcessTicketIdentity, options: ProcessTicketIssueOptions): Promise<ProcessTicketGrant> {
    this.prune(options.now);
    const cap = boundedInt(options.cap, 1, 10_000);
    const activeRows = () => [...this.rows.values()].filter(
      (row) => row.consumedAt === null && sameIdentity(row, identity)
    );
    while (activeRows().length >= cap) {
      const oldest = activeRows().filter((row) => row.claimId === null).sort(
        (a, b) => a.createdAt - b.createdAt || a.ticket.localeCompare(b.ticket)
      )[0];
      if (!oldest) throw new ProcessTicketCapacityError();
      this.rows.delete(oldest.ticket);
    }
    const ticket = randomUUID();
    const extractionId = randomUUID();
    this.rows.set(ticket, {
      ...identity,
      ticket,
      extractionId,
      expiresAt: options.now.getTime() + boundedInt(options.ttlMs, 1_000, 24 * 60 * 60_000),
      createdAt: options.now.getTime(),
      sourceDigest: options.sourceDigest,
      reviewedDigest: null,
      claimId: null,
      claimedAt: null,
      consumedAt: null,
    });
    return { ticket, extractionId };
  }

  async claim(
    ticket: string,
    identity: ProcessTicketIdentity,
    invoiceDigest: string,
    options: ProcessTicketClaimOptions
  ): Promise<ProcessTicketClaim> {
    this.prune(options.now);
    const row = this.rows.get(ticket);
    if (
      !row ||
      row.consumedAt !== null ||
      !sameIdentity(row, identity) ||
      row.sourceDigest !== invoiceDigest
    ) return { status: "invalid" };
    if (row.reviewedDigest && row.reviewedDigest !== invoiceDigest) return { status: "invalid" };
    const staleBefore = options.now.getTime() - boundedInt(options.staleAfterMs, 1_000, 24 * 60 * 60_000);
    if (row.claimId && (row.claimedAt ?? options.now.getTime()) > staleBefore) return { status: "busy" };
    const claimId = randomUUID();
    row.reviewedDigest ??= invoiceDigest;
    row.claimId = claimId;
    row.claimedAt = options.now.getTime();
    return { status: "claimed", claimId };
  }

  async release(ticket: string, claimId: string): Promise<boolean> {
    const row = this.rows.get(ticket);
    if (!row || row.claimId !== claimId) return false;
    row.claimId = null;
    row.claimedAt = null;
    return true;
  }

  async complete(ticket: string, claimId: string, now = new Date()): Promise<boolean> {
    const row = this.rows.get(ticket);
    if (!row || row.claimId !== claimId) return false;
    row.consumedAt = now.getTime();
    row.claimId = null;
    row.claimedAt = null;
    return true;
  }

  private prune(now: Date): void {
    const nowMs = now.getTime();
    const day = utcDay(now);
    for (const [ticket, row] of this.rows) {
      if (
        (row.consumedAt === null && (row.expiresAt <= nowMs || row.day !== day)) ||
        (row.consumedAt !== null && row.consumedAt < nowMs - 14 * 24 * 60 * 60_000)
      ) this.rows.delete(ticket);
    }
  }
}

export class PgProcessTicketStore implements ProcessTicketStore {
  async issue(identity: ProcessTicketIdentity, options: ProcessTicketIssueOptions): Promise<ProcessTicketGrant> {
    const ticket = randomUUID();
    const extractionId = randomUUID();
    const ticketHash = hashTicket(ticket);
    const cap = boundedInt(options.cap, 1, 10_000);
    const expiresAt = new Date(
      options.now.getTime() + boundedInt(options.ttlMs, 1_000, 24 * 60 * 60_000)
    );
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        // Serialize bounded eviction across issuers. This is deliberately a
        // transaction-scoped advisory lock, so a crashed issuer cannot retain it.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ap_process_ticket_issue'))");
        await client.query(
          `DELETE FROM ap_process_tickets
            WHERE (state = 'issued' AND (expires_at <= $1 OR day <> $2::date))
               OR (state = 'consumed' AND consumed_at < $1 - interval '14 days')`,
          [options.now, identity.day]
        );
        await client.query(
          `DELETE FROM ap_process_tickets
            WHERE ticket_hash IN (
              SELECT ticket_hash
                FROM ap_process_tickets
               WHERE state = 'issued'
                 AND tier = $2
                 AND binding_hash = $3
                 AND day = $4::date
                 AND claim_id IS NULL
               ORDER BY created_at ASC, ticket_hash ASC
               LIMIT GREATEST((
                 SELECT count(*) FROM ap_process_tickets
                  WHERE state = 'issued' AND tier = $2 AND binding_hash = $3 AND day = $4::date
               ) - $1 + 1, 0)
            )`,
          [cap, identity.tier, identity.bindingHash, identity.day]
        );
        const active = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM ap_process_tickets
            WHERE state = 'issued' AND tier = $1 AND binding_hash = $2 AND day = $3::date`,
          [identity.tier, identity.bindingHash, identity.day]
        );
        if (Number(active.rows[0]?.count ?? 0) >= cap) {
          throw new ProcessTicketCapacityError();
        }
        await client.query(
          `INSERT INTO ap_process_tickets
             (ticket_hash, extraction_id, tier, binding_hash, day, expires_at, source_digest)
           VALUES ($1, $2::uuid, $3, $4, $5::date, $6, $7)`,
          [ticketHash, extractionId, identity.tier, identity.bindingHash, identity.day, expiresAt, options.sourceDigest]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
    return { ticket, extractionId };
  }

  async claim(
    ticket: string,
    identity: ProcessTicketIdentity,
    invoiceDigest: string,
    options: ProcessTicketClaimOptions
  ): Promise<ProcessTicketClaim> {
    if (!isUuid(ticket)) return { status: "invalid" };
    const ticketHash = hashTicket(ticket);
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const selected = await client.query<PgTicketRow>(
          `SELECT tier, binding_hash, day::text, expires_at, source_digest, reviewed_digest,
                  claim_id::text, claimed_at, state
             FROM ap_process_tickets
            WHERE ticket_hash = $1
            FOR UPDATE`,
          [ticketHash]
        );
        const row = selected.rows[0];
        if (
          !row ||
          row.state !== "issued" ||
          row.tier !== identity.tier ||
          row.binding_hash !== identity.bindingHash ||
          row.day !== identity.day ||
          new Date(row.expires_at).getTime() <= options.now.getTime() ||
          row.source_digest !== invoiceDigest ||
          (row.reviewed_digest !== null && row.reviewed_digest !== invoiceDigest)
        ) {
          await client.query("COMMIT");
          return { status: "invalid" } as ProcessTicketClaim;
        }
        const staleBefore =
          options.now.getTime() - boundedInt(options.staleAfterMs, 1_000, 24 * 60 * 60_000);
        if (
          row.claim_id &&
          (row.claimed_at === null || new Date(row.claimed_at).getTime() > staleBefore)
        ) {
          await client.query("COMMIT");
          return { status: "busy" } as ProcessTicketClaim;
        }
        const claimId = randomUUID();
        await client.query(
          `UPDATE ap_process_tickets
              SET reviewed_digest = COALESCE(reviewed_digest, $2),
                  claim_id = $3::uuid,
                  claimed_at = $4
            WHERE ticket_hash = $1`,
          [ticketHash, invoiceDigest, claimId, options.now]
        );
        await client.query("COMMIT");
        return { status: "claimed", claimId } as ProcessTicketClaim;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  async release(ticket: string, claimId: string): Promise<boolean> {
    if (!isUuid(ticket) || !isUuid(claimId)) return false;
    const ticketHash = hashTicket(ticket);
    return withClient(async (client) => {
      const result = await client.query(
        `UPDATE ap_process_tickets
            SET claim_id = NULL, claimed_at = NULL
          WHERE ticket_hash = $1 AND claim_id = $2::uuid AND state = 'issued'`,
        [ticketHash, claimId]
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async complete(ticket: string, claimId: string, now = new Date()): Promise<boolean> {
    if (!isUuid(ticket) || !isUuid(claimId)) return false;
    const ticketHash = hashTicket(ticket);
    return withClient(async (client) => {
      const result = await client.query(
        `UPDATE ap_process_tickets
            SET state = 'consumed', consumed_at = $3, claim_id = NULL, claimed_at = NULL
          WHERE ticket_hash = $1 AND claim_id = $2::uuid AND state = 'issued'`,
        [ticketHash, claimId, now]
      );
      return (result.rowCount ?? 0) === 1;
    });
  }
}

interface PgTicketRow {
  tier: ProcessTicketTier;
  binding_hash: string;
  day: string;
  expires_at: string | Date;
  source_digest: string;
  reviewed_digest: string | null;
  claim_id: string | null;
  claimed_at: string | Date | null;
  state: "issued" | "consumed";
}

function sameIdentity(a: ProcessTicketIdentity, b: ProcessTicketIdentity): boolean {
  return a.tier === b.tier && a.bindingHash === b.bindingHash && a.day === b.day;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

function boundedInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
