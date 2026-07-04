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
#   npm start                     # in another terminal (offline Fakes need no key)
#   bash demo/capture_demo.sh     # or: BASE_URL=http://host:9000 bash demo/capture_demo.sh
#
# Works with real Qwen + a database too — just point BASE_URL at the deployed URL.
# jq is used when present; a grep/sed fallback keeps it working without jq.

# No `set -e`: the grep/sed fallbacks may legitimately not match, and a demo
# capture should keep going and print what it has rather than abort mid-walkthrough.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:9000}"

# ── tiny helpers ──────────────────────────────────────────────────────────────
have_jq() { command -v jq >/dev/null 2>&1; }

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
post() { printf '%s' "$2" | curl -s -X POST "$BASE_URL$1" -H 'content-type: application/json' --data-binary @-; }
get()  { curl -s "$BASE_URL$1"; }

hr() { printf '%s\n' "────────────────────────────────────────────────────────────────────────────"; }
step() { hr; printf '▶ %s\n' "$1"; }

# Intake an invoice, print the proposal, and echo the work-item id on stdout (last line).
intake() { # intake <label> <invoice-json>
  local label="$1" invoice="$2" res tool conf reason id
  step "INTAKE — $label"
  res="$(post /intake "{\"invoice\":$invoice}")"
  id="$(field "$res" id)"
  if have_jq; then
    tool="$(printf '%s' "$res" | jq -r '.proposed.tool')"
    conf="$(printf '%s' "$res" | jq -r '.proposed.confidence')"
    reason="$(printf '%s' "$res" | jq -r '.proposed.reasoning')"
    printf '  findings failed : %s\n' "$(printf '%s' "$res" | jq -r '[.findings[] | select(.passed==false) | .rule] | join(", ") | if .=="" then "none (all pass)" else . end')"
  else
    tool="$(grab "$res" tool)"
    conf="?"; reason="(install jq for full findings/confidence detail)"
  fi
  printf '  proposed action : %s   (confidence %s)\n' "$tool" "$conf"
  printf '  reasoning       : %s\n' "$reason"
  printf '  work item       : %s   → PENDING (nothing executed yet)\n' "$id"
  printf '%s' "$id" >/tmp/.autopilot_last_id
}

approve() { # approve <id>
  local id="$1" res summary
  step "HUMAN APPROVES $id — the tool executes for real"
  res="$(post "/approve/$id" '{}')"
  if have_jq; then summary="$(printf '%s' "$res" | jq -r '.execution.summary')"; else summary="$(grab "$res" summary)"; fi
  printf '  executed        : %s\n' "$summary"
  printf '  → outcome written back to memory (the next decision for this vendor sees it)\n'
}

# ── the walkthrough ───────────────────────────────────────────────────────────
step "HEALTH — which embedder + decider are live?"
get /health; echo

# 1) A messy invoice from a brand-new vendor → draft a journal entry.
intake "messy invoice, NEW vendor 'Northwind Supplies' (alias keys + EU string amounts)" \
  '{"supplier":"Northwind Supplies","reference":"NW-1001","issued":"2026-02-03","net":"1.000,00","vat":"200,00","amount_due":"EUR 1.200,00","tax_number":"TX-8842","ccy":"eur"}'
ID1="$(cat /tmp/.autopilot_last_id)"

# 2) The approval queue.
step "GET /pending — the human approval queue"
if have_jq; then get /pending | jq '.pending | map({id, vendor: .invoice.vendor, tool: .proposed.tool, status})'; else get /pending; fi
echo

# 3) Approve invoice 1 → it executes, outcome remembered.
approve "$ID1"

# 4) SAME vendor again, clean → now recognised as recurring → payment (memory loop!).
intake "second invoice from the SAME vendor (now KNOWN) → decision reflects recalled history" \
  '{"vendor":"Northwind Supplies","invoice_number":"NW-1002","date":"2026-03-03","subtotal":1100,"tax":220,"total":1320,"tax_id":"TX-8842","currency":"EUR"}'
ID2="$(cat /tmp/.autopilot_last_id)"
approve "$ID2"

# 5) A duplicate of invoice 1 → flagged for human review (grounded in memory).
intake "a DUPLICATE of NW-1001 → flagged for review (grounded in recalled memory)" \
  '{"vendor":"Northwind Supplies","invoice_number":"NW-1001","date":"2026-02-03","subtotal":1000,"tax":200,"total":1200,"tax_id":"TX-8842","currency":"EUR"}'
ID3="$(cat /tmp/.autopilot_last_id)"
step "HUMAN REJECTS $ID3 — confirmed duplicate, do not pay twice"
post "/reject/$ID3" '{"reason":"Confirmed duplicate of NW-1001 - do not pay twice."}' >/dev/null
printf '  rejected        : nothing executed; the rejection is remembered\n'

hr
printf '✓ Full loop: messy intake → Qwen proposes → human gate → execute → remember.\n'
printf '  The vendor went new-vendor (journal entry) → known-vendor (payment) → duplicate (flagged)\n'
printf '  purely from what the agent recalled across intakes. That is the memory write-back loop.\n'
hr
rm -f /tmp/.autopilot_last_id
