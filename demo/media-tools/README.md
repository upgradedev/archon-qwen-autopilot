# Final live-media pipeline

This project-contained pipeline creates the five exact renderer inputs and a
1280×720 YouTube thumbnail from the exact **deployed Autopilot runtime release**. It is
stateful by design: it runs uniquely prefixed synthetic invoices through the real
reviewer path, captures real UI states, then rejects every still-PENDING capture item.
It never approves a payment or vendor reply.

Nothing is written outside this repository. Raw candidates, controller evidence and
the detailed private copy of the capture manifest remain under ignored
`demo/.private-captures/`. A secret-safe canonical
`demo/gallery/CAPTURE_REVIEW.json` is promoted with the images and is intended to be
tracked. Canonical files are replaced as one rollback-capable transaction only after
every gate—including authenticated cleanup and a zero-residue re-query—passes.
The tool records no browser trace/video and refuses to start when capture scratch
exceeds 750 MiB (bounded by `MAX_CAPTURE_SCRATCH_MB`), preventing repeated failed
runs from silently consuming the host disk.

## Stage the private release binding

Stage the latest exact-deploy controller records in these ignored paths. Preserve the
exact output bytes; do not rewrite or normalize them:

```text
demo/.private-captures/release/exact-deploy-status.json
demo/.private-captures/release/exact-deploy-output.txt
demo/.private-captures/release/expected-autopilot-sha.txt
```

The SHA file contains exactly the selected 40-character deployed runtime SHA plus a
newline. For the current release, the status uses the exact-closed
`cloud-assistant-sentinel-v1` schema and SHA-256-binds the untouched compact controller
output from the same terminal-success attempt. The pipeline validates every documented
safe output field and its success semantics; it never invents legacy log markers.
`deploy/DEPLOY_STATE.md` must name the same deployed runtime SHA. The legacy marker
adapter remains only for authentic historical controller records.

The pipeline cross-checks all four sources and their age, then verifies that the
deployed runtime SHA is an ancestor of the clean **capture-source HEAD**. That HEAD
must equal freshly fetched public `origin/main`. The generated media/publication commit
will follow it and must be linked separately as the **final submitted HEAD**. `/health`
is deliberately **not** treated as source attestation.

The project-local `.env` supplies `REVIEWER_TOKEN` in memory. Do not paste the token
into a command, URL, screenshot, evidence file or shell history.

## One-command capture

After `npm ci`, with fresh project-contained evidence from the already completed
exact deployment staged under `demo/.private-captures/release/`:

```bash
node demo/media-tools/capture-final-media.cjs \
  --reviewer-credential-file .artifacts/devpost/reviewer-credential.json \
  --alibaba-raw demo/.private-captures/alibaba/alibaba-ecs-overview-raw.png
```

Optional environment locks are `AUTOPILOT_URL`, `EXPECTED_DECISION_MODEL`,
`EXPECTED_EMBEDDING_MODEL`, and `EXPECTED_VISION_MODEL`. The baseline defaults are
the project deployment values. `GITHUB_TOKEN` may be supplied in the environment to
avoid anonymous public-API rate limits; it is never logged or stored.

The optional `--reviewer-credential-file` is the explicit, safe way to load the
ignored `.artifacts/devpost/reviewer-credential.json` (`token` field) into memory.
The tool refuses a credential file that is outside the repository or not gitignored,
and never echoes or copies its value. Omit the option to use the project-local `.env`.

`--alibaba-raw` must point to a fresh, genuine Alibaba ECS console PNG under a
gitignored path inside this repository. The tracked
`alibaba-proof-redaction.json` profile selects a provider/service-only crop that
excludes the administrative principal, instance identity, address, and resource
controls. The raw SHA-256 and profile SHA-256 are bound into
`demo/gallery/CAPTURE_REVIEW.json`; only the metadata-stripped composite is promoted.

The command aborts without promotion unless all of these are true:

- exact deployed-runtime SHA, closed-schema terminal status, hash-bound compact output,
  and fresh evidence age;
- exact-SHA `CI`, `CodeQL`, and `Production Image Supply Chain` runs are green;
- public `/health` says `pgvector` and exact decision/embedding IDs;
- `/ready` proves reviewer auth, PostgreSQL, Qwen configuration and zero incompatible
  embedding rows;
- authenticated, metered `/ready/deep` exercises the exact embedding model;
- unauthenticated `/pending` returns `401`;
- a fresh document extraction exercises the exact vision model;
- a fresh live invoice reaches durable PENDING with the exact decision model, recall
  first, structural validation present, and only the relevant side-effect-free
  duplicate, variance, or context checks warranted by that invoice—with no execution;
- a genuine Alibaba ECS console capture decodes at the reviewed dimensions, stays
  private, and contributes only the hash-bound safe crop to the publishable proof;
- the three-step correction challenge routes the matching re-bill to review and keeps
  the corrected negative control as a payment proposal, with stored correction evidence;
- a synthetic hostile document visibly surfaces a recognized-injection warning and
  still stops at PENDING;
- authenticated cleanup rejects every still-PENDING item carrying this run's exact
  synthetic prefixes, then a fully paginated authenticated query proves zero matching
  residue;
- every PNG has the exact dimensions, is RGB, contains no metadata, and passes the
  credential-like-content guard.

Successful tracked 1920×1080 video-renderer outputs:

```text
demo/final-media/autopilot-live-intake-pending.png
demo/final-media/autopilot-human-amend-diff.png
demo/final-media/autopilot-correction-learning.png
demo/final-media/autopilot-security-pending.png
demo/final-media/autopilot-alibaba-proof.png
demo/final-media/autopilot-youtube-thumbnail.png
```

The same successful transaction also emits exact 1500×1000 Devpost gallery images:

```text
demo/gallery/autopilot-01-live-intake-pending.png
demo/gallery/autopilot-02-human-amend-diff.png
demo/gallery/autopilot-03-correction-learning.png
demo/gallery/autopilot-04-security-pending.png
demo/gallery/autopilot-05-alibaba-qwen-proof.png
demo/gallery/CAPTURE_REVIEW.json
```

Each gallery file contains the complete 16:9 evidence frame centered on a dark 3:2
canvas (1500×844 content plus 78px mattes). There is no crop or content synthesis;
all critical evidence stays inside the 1920×1080 safe margins.

The proof composite explicitly labels the deployed runtime SHA separately from the
clean public capture-source HEAD. The later final submitted HEAD is linked after the
media commit rather than fabricated in the pre-commit proof. Its Alibaba context is a
hash-bound safe crop from a genuine console PNG read exactly once into immutable
bytes; the same bytes are validated, hashed, and rendered. Alibaba instance/resource,
address, and administrative-principal identifiers are intentionally absent.

The final video build also writes `demo/final-media/autopilot-demo.en.srt`. It has
one English cue per final narration beat, using that beat's exact measured,
frame-quantized audio window and the same canonical text used for burned captions.
`add_rights_safe_narration.py` then synthesizes the pinned local voice and records
model/config/card/revision hashes plus per-cue audio QA. The capture command itself
does not synthesize or publish a voice.

## Safety and retry behavior

If capture fails, inspect only the latest ignored directory under
`demo/.private-captures/`; no candidate is promoted. The `finally` cleanup queries the
complete authenticated queue and rejects only items bearing that run's exact
`SOTA-CAP-*` or deterministic correction-challenge prefix. Any rejection/query
failure, or any matching post-cleanup residue, makes the command exit nonzero before
promotion. Promotion stages every file, preserves the prior reviewed set, commits the
images and canonical manifest together, and rolls back on an exception; an interrupted
transaction is recovered before the next run. Previously decided synthetic correction
evidence is retained as the audit source for the amendment screenshot.

Run the non-network guard tests with:

```bash
node demo/media-tools/capture-final-media.cjs --self-test
python -m py_compile demo/media-tools/sanitize_pngs.py
python -m py_compile demo/media-tools/make_gallery_variants.py scripts/build_video.py
```
