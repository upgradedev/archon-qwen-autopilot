#!/usr/bin/env bash
# capture_demo.sh — drive the full Archon Autopilot loop against a RUNNING backend,
# printing clean, labelled output suitable for a screen recording.
#
# It shows the whole human-in-the-loop AP workflow AND the memory write-back loop:
#
#   1. Intake a messy invoice from a NEW vendor  → the decider proposes an action
#   2. GET /pending                              → the human approval queue
#   3. Approve it                                → the tool executes for real
#   4. Intake the SAME vendor again (clean)      → the decision now reflects recalled
#                                                  history (new-vendor journal entry →
#                                                  known-vendor payment): the memory
#                                                  write-back loop, visible on screen
#   5. Intake a DUPLICATE of step 1              → flagged for human review
#
# Usage:
#   REVIEWER_TOKEN='<private token>' npm start  # in another terminal (offline Fakes need no Qwen key)
#   REVIEWER_TOKEN='<same token>' bash demo/capture_demo.sh
#   # or: BASE_URL=http://host:9000 REVIEWER_TOKEN='<token>' bash demo/capture_demo.sh
#
# Works with real Qwen + a database too — just point BASE_URL at the deployed URL.
# jq is used when present; a grep/sed fallback keeps it working without jq.

# No `set -e`: the grep/sed fallbacks may legitimately not match, and a demo
# capture should keep going and print what it has rather than abort mid-walkthrough.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:9000}"
REVIEWER_TOKEN="${REVIEWER_TOKEN:-}"
if [[ -z "$REVIEWER_TOKEN" ]]; then
  printf '%s\n' 'REVIEWER_TOKEN is required for the durable review/approval walkthrough.' >&2
  exit 1
fi
DEFAULT_RUN_ID="${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}-${GITHUB_RUN_ATTEMPT:-${BASHPID:-$$}}"
DEMO_RUN_ID="${DEMO_RUN_ID:-$DEFAULT_RUN_ID}"
if [[ ! "$DEMO_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]]; then
  printf '%s\n' 'DEMO_RUN_ID must be 1-32 ASCII letters, digits, underscore, or hyphen and start alphanumeric.' >&2
  exit 1
fi
VENDOR="Pinecrest Demo $DEMO_RUN_ID"
REF1="PS-$DEMO_RUN_ID-1"
REF2="PS-$DEMO_RUN_ID-2"
TAX_ID="TX-$DEMO_RUN_ID"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$(node "$REPO_ROOT/scripts/repo-path.cjs" --label STATE_DIR "$REPO_ROOT/.artifacts/work")" || exit 1
STATE_FILE="$(node "$REPO_ROOT/scripts/repo-path.cjs" --label STATE_FILE "$STATE_DIR/autopilot_last_id_$DEMO_RUN_ID")" || exit 1
mkdir -p "$STATE_DIR"
trap 'rm -f -- "$STATE_FILE"' EXIT

# ── tiny helpers ──────────────────────────────────────────────────────────────
have_jq() { command -v jq >/dev/null 2>&1; }
fail() { printf 'ERROR: %s\n' "$1" >&2; return 1; }

# First value of a "key":"value" string field in a JSON blob (grep -m1 → no SIGPIPE).
grab() { # grab <json> <key>
  printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" -m1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' || true
}

# Extract a top-level string field from a JSON blob (jq if available, else grep).
field() { # field <json> <key>
  local json="$1" key="$2"
  if have_jq; then printf '%s' "$json" | jq -r ".$key // empty"; else grab "$json" "${key##*.}"; fi
}

# POST a JSON body via stdin (--data-binary @-) so curl sets Content-Length from the
# actual byte count. `-d` miscounts multibyte UTF-8 on some platforms (Windows curl),
# which silently 400s the request ("body size did not match Content-Length").
post() { printf '%s' "$2" | curl -fsS --connect-timeout 10 --max-time 90 -X POST "$BASE_URL$1" -H 'content-type: application/json' -H "authorization: Bearer $REVIEWER_TOKEN" --data-binary @-; }
get()  { curl -fsS --connect-timeout 10 --max-time 90 "$BASE_URL$1" -H "authorization: Bearer $REVIEWER_TOKEN"; }

hr() { printf '%s\n' "────────────────────────────────────────────────────────────────────────────"; }
step() { hr; printf '▶ %s\n' "$1"; }

# Intake an invoice, print the proposal, and echo the work-item id on stdout (last line).
intake() { # intake <label> <invoice-json> <expected-tool>
  local label="$1" invoice="$2" expected_tool="$3" res tool conf reason id status
  step "INTAKE — $label"
  if ! res="$(post /intake "{\"invoice\":$invoice}")"; then
    fail "intake request failed"
    return 1
  fi
  if have_jq && ! printf '%s' "$res" | jq -e . >/dev/null; then
    fail "intake returned invalid JSON"
    return 1
  fi
  id="$(field "$res" id)"
  status="$(field "$res" status)"
  if have_jq; then
    tool="$(printf '%s' "$res" | jq -r '.proposed.tool')"
    conf="$(printf '%s' "$res" | jq -r '.proposed.confidence')"
    reason="$(printf '%s' "$res" | jq -r '.proposed.reasoning')"
    printf '  findings failed : %s\n' "$(printf '%s' "$res" | jq -r '[.findings[] | select(.passed==false) | .rule] | join(", ") | if .=="" then "none (all pass)" else . end')"
  else
    tool="$(grab "$res" tool)"
    conf="?"; reason="(install jq for full findings/confidence detail)"
  fi
  if [[ -z "$id" || "$status" != "pending" || "$tool" != "$expected_tool" ]]; then
    fail "intake proof mismatch (id/status/tool must be non-empty, pending, and $expected_tool)"
    return 1
  fi
  printf '  proposed action : %s   (confidence %s)\n' "$tool" "$conf"
  printf '  reasoning       : %s\n' "$reason"
  printf '  work item       : %s   → PENDING (nothing executed yet)\n' "$id"
  printf '%s' "$id" >"$STATE_FILE"
}

approve() { # approve <id>
  local id="$1" res summary status execution_ok=false
  step "HUMAN APPROVES $id — the tool executes for real"
  if ! res="$(post "/approve/$id" '{}')"; then
    fail "approval request failed"
    return 1
  fi
  status="$(field "$res" status)"
  if have_jq; then
    summary="$(printf '%s' "$res" | jq -r '.execution.summary // empty')"
    if printf '%s' "$res" | jq -e '.execution.ok == true' >/dev/null; then execution_ok=true; fi
  else
    summary="$(grab "$res" summary)"
    if printf '%s' "$res" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then execution_ok=true; fi
  fi
  if [[ "$status" != "approved" || "$execution_ok" != true || -z "$summary" ]]; then
    fail "approval did not return approved with execution.ok=true and a summary"
    return 1
  fi
  printf '  executed        : %s\n' "$summary"
  printf '  → outcome written back to memory (the next decision for this vendor sees it)\n'
}

reject() { # reject <id> <reason>
  local id="$1" reason="$2" res status
  if ! res="$(post "/reject/$id" "{\"reason\":\"$reason\"}")"; then
    fail "rejection request failed"
    return 1
  fi
  status="$(field "$res" status)"
  if [[ "$status" != "rejected" ]]; then
    fail "rejection did not return rejected"
    return 1
  fi
}

# ── the walkthrough ───────────────────────────────────────────────────────────
step "HEALTH — which embedder + decider are live?"
if ! HEALTH="$(get /health)"; then fail "health request failed"; exit 1; fi
printf '%s\n' "$HEALTH"

# 1) A messy invoice from a brand-new vendor → draft a journal entry.
intake "messy invoice, NEW vendor '$VENDOR' (alias keys + EU string amounts)" \
  "{\"supplier\":\"$VENDOR\",\"reference\":\"$REF1\",\"issued\":\"2026-02-03\",\"net\":\"1.000,00\",\"vat\":\"200,00\",\"amount_due\":\"EUR 1.200,00\",\"tax_number\":\"$TAX_ID\",\"ccy\":\"eur\"}" \
  draft_journal_entry || exit 1
ID1="$(cat "$STATE_FILE")"

# 2) The approval queue.
step "GET /pending — the human approval queue"
if ! PENDING="$(get /pending)"; then fail "pending request failed"; exit 1; fi
if have_jq; then
  if ! printf '%s' "$PENDING" | jq -e --arg id "$ID1" '.pending | any(.id == $id and .status == "pending")' >/dev/null; then
    fail "new work item was not present as pending"
    exit 1
  fi
  printf '%s' "$PENDING" | jq '.pending | map({id, vendor: .invoice.vendor, tool: .proposed.tool, status})'
else
  if ! printf '%s' "$PENDING" | grep -Fq "$ID1" || ! printf '%s' "$PENDING" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"pending"'; then
    fail "new work item was not present as pending"
    exit 1
  fi
  printf '%s' "$PENDING"
fi
echo

# 3) Approve invoice 1 → it executes, outcome remembered.
approve "$ID1" || exit 1

# 4) SAME vendor again, clean → now recognised as recurring → payment (memory loop!).
intake "second invoice from the SAME vendor (now KNOWN) → decision reflects recalled history" \
  "{\"vendor\":\"$VENDOR\",\"invoice_number\":\"$REF2\",\"date\":\"2026-03-03\",\"subtotal\":1100,\"tax\":220,\"total\":1320,\"tax_id\":\"$TAX_ID\",\"currency\":\"EUR\"}" \
  draft_payment || exit 1
ID2="$(cat "$STATE_FILE")"
approve "$ID2" || exit 1

# 5) A duplicate of invoice 1 → flagged for human review (grounded in memory).
intake "a DUPLICATE of $REF1 → flagged for review (grounded in recalled memory)" \
  "{\"vendor\":\"$VENDOR\",\"invoice_number\":\"$REF1\",\"date\":\"2026-02-03\",\"subtotal\":1000,\"tax\":200,\"total\":1200,\"tax_id\":\"$TAX_ID\",\"currency\":\"EUR\"}" \
  flag_for_review || exit 1
ID3="$(cat "$STATE_FILE")"
step "HUMAN REJECTS $ID3 — confirmed duplicate, do not pay twice"
reject "$ID3" "Confirmed duplicate of $REF1 - do not pay twice." || exit 1
printf '  rejected        : nothing executed; the rejection is remembered\n'

hr
printf '✓ Full loop: messy intake → Qwen proposes → human gate → execute → remember.\n'
printf '  The vendor went new-vendor (journal entry) → known-vendor (payment) → duplicate (flagged)\n'
printf '  purely from what the agent recalled across intakes. That is the memory write-back loop.\n'
hr
