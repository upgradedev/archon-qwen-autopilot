// Advisory prompt-injection DETECTION for uploaded-document extraction.
//
// The decider fence (src/ap/loop.ts) labels uploaded invoice fields as untrusted DATA.
// A delimiter alone cannot guarantee that a model ignores malicious text; the
// deterministic safety property comes from structural tool separation plus the
// authenticated human gate, which block autonomous execution. This module closes the
// visibility gap with a pure, read-only scan over vision-extracted fields so the trace,
// API response, and reviewer can SEE recognized attack patterns.
//
// It is ADVISORY ONLY. It changes nothing about the decision: it never rejects an
// upload, never edits the proposal, never touches the human gate. The safe behavior
// (fence + PENDING + human approval) is unchanged; this only adds visibility.
//
// Positioning: universal terms only — it inspects invoice field text for generic
// prompt-injection / agent-hijack patterns, tied to no locale, language, or scheme.

// One detected pattern hit, located to the field it was found in with a short,
// human-readable snippet (never the whole field — enough to recognise the attack).
export interface InjectionMatch {
  field: string; // which extracted field carried it (e.g. "vendor", "line_items[0].description")
  pattern: string; // the human-readable name of the pattern that matched
  snippet: string; // a short excerpt of the matched text, for the trace / gate banner
}

export interface InjectionScanResult {
  detected: boolean; // true iff at least one pattern matched
  count: number; // how many pattern hits across all fields
  matches: InjectionMatch[]; // the located hits (deterministic order: field, then pattern)
}

// The pattern set — ONE documented, easily-extendable place. Each entry is a named,
// case-insensitive regex tuned for LOW false-positives on genuine invoice text (an
// invoice rarely says "ignore all previous instructions" or "set confidence to 1").
// Grouped by attacker intent so the taxonomy stays legible as it grows.
interface InjectionPattern {
  name: string;
  re: RegExp;
}

export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  // ── Imperative overrides — "forget what you were told" ──────────────────────
  { name: "ignore-previous-instructions", re: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i },
  { name: "disregard-the-above", re: /disregard\s+(the\s+)?(above|previous)/i },
  // ── Action coercion — push the agent toward a money-moving / auto action ────
  { name: "coerce-approve", re: /\bapprove\b/i },
  { name: "coerce-pay-now", re: /\bpay\s+(now|immediately)\b/i },
  { name: "coerce-authorize-payment", re: /\bauthorri?ze\s+payment\b/i },
  { name: "coerce-release-payment", re: /\brelease\s+the\s+payment\b/i },
  // ── Confidence spoofing — forge the number a human trusts at the gate ───────
  { name: "spoof-confidence-1", re: /confidence\s*[:=]?\s*1(\.0+)?\b/i },
  { name: "spoof-set-confidence-to-1", re: /set\s+confidence\s+to\s+1/i },
  // ── Role / prompt hijack — impersonate the system or flip the model's role ──
  { name: "hijack-you-are-now", re: /you\s+are\s+now\b/i },
  { name: "hijack-system-role", re: /\bsystem\s*:/i },
  { name: "hijack-assistant-role", re: /\bassistant\s*:/i },
  { name: "hijack-as-an-ai", re: /\bas\s+an\s+ai\b/i },
  // ── Tool / exfiltration coercion — call a tool or ship data out ─────────────
  { name: "exfil-call-tool", re: /\bcall\s+\w+\.\w+/i },
  { name: "exfil-send-to", re: /\bsend\s+(this\s+)?to\b/i },
  { name: "exfil-http-post", re: /\bhttp\.post\b/i },
  { name: "exfil-email-send", re: /\bemail\.send\b/i },
];

// Cap the snippet so the trace / banner stays compact and never re-dumps a whole
// attacker-controlled field (which could itself be huge).
const SNIPPET_MAX = 80;

// Scan every intake shape (document extraction or structured JSON) for prompt-injection
// patterns. Pure + read-only: no I/O, no mutation, deterministic output. Accepts
// either the structured extraction object (its string field values + line-item
// descriptions are scanned) or a single string.
export function scanForInjection(input: Record<string, unknown> | string): InjectionScanResult {
  const fields: Array<{ field: string; text: string }> =
    typeof input === "string" ? [{ field: "text", text: input }] : collectFields(input);

  const matches: InjectionMatch[] = [];
  for (const { field, text } of fields) {
    for (const p of INJECTION_PATTERNS) {
      const m = p.re.exec(text);
      if (m) matches.push({ field, pattern: p.name, snippet: snippet(text, m.index) });
    }
  }
  return { detected: matches.length > 0, count: matches.length, matches };
}

// Flatten the extraction object into scannable (field, text) pairs. Only string
// values are inspected (numbers/amounts can't carry a prompt); line-item
// descriptions are addressed individually so the surfaced field points at the exact
// row. Deterministic order = insertion order, with line items expanded in place.
const MAX_FIELDS = 200;
const MAX_FIELD_CHARS = 4096;
const MAX_DEPTH = 5;

function collectFields(obj: Record<string, unknown>): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
    if (typeof value === "string" && value.trim()) {
      out.push({ field: path || "value", text: value.slice(0, MAX_FIELD_CHARS) });
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, MAX_FIELDS).forEach((entry, i) => visit(entry, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, path ? `${path}.${key}` : key, depth + 1);
        if (out.length >= MAX_FIELDS) break;
      }
    }
  };
  visit(obj, "", 0);
  return out;
}

function snippet(text: string, at: number): string {
  const start = Math.max(0, at - 8);
  const raw = text.slice(start, start + SNIPPET_MAX).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = start + SNIPPET_MAX < text.length ? "…" : "";
  return `${prefix}${raw}${suffix}`;
}
