# Final live-media pipeline

This project-contained pipeline creates the five exact renderer inputs and a
1280×720 YouTube thumbnail from the **final deployed Autopilot release**. It is
stateful by design: it runs uniquely prefixed synthetic invoices through the real
reviewer path, captures real UI states, then rejects every still-PENDING capture item.
It never approves a payment or vendor reply.

Nothing is written outside this repository. Raw candidates, controller evidence and
the detailed capture manifest remain under ignored `demo/.private-captures/`. Tracked
files under `demo/final-media/` are replaced only after every gate passes.
The tool records no browser trace/video and refuses to start when capture scratch
exceeds 750 MiB (bounded by `MAX_CAPTURE_SCRATCH_MB`), preventing repeated failed
runs from silently consuming the host disk.

## Stage the private release binding

Copy the latest exact-deploy controller outputs into these ignored paths **without
editing their contents**:

```text
demo/.private-captures/release/exact-deploy-status.json
demo/.private-captures/release/exact-deploy-output.txt
demo/.private-captures/release/expected-autopilot-sha.txt
```

The SHA file contains exactly the selected 40-character Autopilot application SHA
plus a newline. The status and output must come from the same terminal-success
controller attempt. `deploy/DEPLOY_STATE.md` must name that exact application SHA.
The pipeline cross-checks all four sources, their age, exact checkout/deploy/success
markers, and verifies that the release SHA is an ancestor of the later docs/media
submission HEAD. `/health` is deliberately **not** treated as source attestation.

The project-local `.env` supplies `REVIEWER_TOKEN` in memory. Do not paste the token
into a command, URL, screenshot, evidence file or shell history.

## One-command capture

After `npm ci` and the exact redeploy:

```bash
node demo/media-tools/capture-final-media.cjs \
  --reviewer-credential-file .artifacts/devpost/reviewer-credential.json
```

Optional environment locks are `AUTOPILOT_URL`, `EXPECTED_DECISION_MODEL`,
`EXPECTED_EMBEDDING_MODEL`, and `EXPECTED_VISION_MODEL`. The baseline defaults are
the project deployment values. `GITHUB_TOKEN` may be supplied in the environment to
avoid anonymous public-API rate limits; it is never logged or stored.

The optional `--reviewer-credential-file` is the explicit, safe way to load the
ignored `.artifacts/devpost/reviewer-credential.json` (`token` field) into memory.
The tool refuses a credential file that is outside the repository or not gitignored,
and never echoes or copies its value. Omit the option to use the project-local `.env`.

The command aborts without promotion unless all of these are true:

- exact deploy-controller SHA/status/output and fresh evidence age;
- exact-SHA `CI`, `CodeQL`, and `Production Image Supply Chain` runs are green;
- public `/health` says `pgvector` and exact decision/embedding IDs;
- `/ready` proves reviewer auth, PostgreSQL, Qwen configuration and zero incompatible
  embedding rows;
- authenticated, metered `/ready/deep` exercises the exact embedding model;
- unauthenticated `/pending` returns `401`;
- a fresh document extraction exercises the exact vision model;
- a fresh live invoice reaches durable PENDING with all four required evidence tools
  and the exact decision model, with no execution;
- the three-step correction challenge yields `€5,000 → flag_for_review` and the
  `€3,000 → draft_payment` negative control, with stored correction evidence;
- a synthetic hostile document visibly surfaces a recognized-injection warning and
  still stops at PENDING;
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
```

Each gallery file contains the complete 16:9 evidence frame centered on a dark 3:2
canvas (1500×844 content plus 78px mattes). There is no crop or content synthesis;
all critical evidence stays inside the 1920×1080 safe margins.

The proof composite explicitly labels the deploy-controller application SHA
separately from a later docs/media-only submission HEAD. Alibaba instance/resource
and administrative-principal identifiers are intentionally absent.

The final video build also writes `demo/final-media/autopilot-demo.en.srt`. It has
one English cue per final narration beat, using that beat's exact measured,
frame-quantized audio window. The capture command itself does not synthesize or
publish a voice and does not make any voice-rights assertion.

## Safety and retry behavior

If capture fails, inspect only the latest ignored directory under
`demo/.private-captures/`; no partial candidate is promoted. The `finally` cleanup
queries the authenticated queue and rejects only vendors bearing that run's exact
`SOTA-CAP-*` or deterministic correction-challenge prefix. A failed cleanup is
reported and must be completed through the
reviewer UI before another run. Previously decided synthetic correction evidence is
retained as the audit source for the amendment screenshot.

Run the non-network guard tests with:

```bash
node demo/media-tools/capture-final-media.cjs --self-test
python -m py_compile demo/media-tools/sanitize_pngs.py
python -m py_compile demo/media-tools/make_gallery_variants.py scripts/build_video.py
```
