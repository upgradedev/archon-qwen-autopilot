# Exact release + Alibaba/Qwen proof runbook

This is the fail-closed provenance runbook for the final Autopilot recording. It is
an instruction sheet, **not deployment evidence by itself**. The accepted evidence is
the sanitized `demo/final-media/autopilot-alibaba-proof.png` plus the corresponding
scene in the public video.

All raw captures and command output stay inside this repository under ignored
`.artifacts/` or `demo/.private-captures/`. Never use an OS temp folder, another
project, a chat attachment, or a desktop scratch file as the only copy.

## Release identity lock

- Exact final application release audited, deployed, and verified on 2026-07-16:
  **`203f159df25f825a0b994a2f8a4d2c0892b45390`**. Project-contained exact-deploy
  attempt 23 completed with terminal `Success`, exit code `0`, the application marker,
  and the aggregate success marker.
- [x] The exact final application SHA was fetched, clean, built, deployed, and
  exercised through every gate below before media capture.
- Project-contained redacted evidence records exact checkout, immutable post-merge
  CI, production build, singleton runtime-env proof, schema/bootstrap, least privilege,
  cross-database denial, health/readiness/deep readiness, a live
  `qwen-vl-max` extraction, a real `qwen-plus` multi-step intake→PENDING smoke with
  authenticated rejection and targeted cleanup, and public TLS canaries for that SHA.
- A later documentation/media-only submission commit may legitimately differ from
  the deployed application SHA. Record both identities and describe them accurately.
- Any later change to runtime code, dependencies, Docker context, deployment scripts,
  schema, or configuration defaults invalidates this release target and requires a
  new exact-SHA deploy, CI run, and proof pass.
- Never infer a deployed SHA from the public hostname, a local branch name, an image
  tag such as `latest`, or an old successful screenshot.

The expected baseline runtime models for the final candidate are:

| Role | Expected ID | Where the final proof comes from |
|---|---|---|
| Decision/function calling | `qwen-plus` | `/health` **and** an authenticated intake→PENDING canary's `proposed.modelId` |
| Embeddings | `text-embedding-v4` | `/health`, `/ready`, and authenticated `/ready/deep` |
| Document vision | `qwen-vl-max` | A fresh document extraction response; `/health` does not expose the vision ID |

`qwen3.7-plus-2026-05-26` is only a candidate. Do not place it in the video, post,
Devpost copy, environment, or proof image unless a clean, same-application-SHA,
counterbalanced artifact satisfies every gate in
[`../docs/MODEL_PROMOTION.md`](../docs/MODEL_PROMOTION.md) and reports
`promotion-pass`. If promotion does not pass, the baseline IDs above are the final
truth; a negative promotion result is evidence of disciplined release engineering,
not a reason to relabel the runtime.

## 1 · Prove source and build identity privately

On the deployment host, from the Autopilot checkout, capture the following into a
repo-contained private text/screen recording. Do not capture the shell history,
remote URL with credentials, `.env`, `docker inspect`, cloud instance ID, public IP
inventory, key path, or administrative principal.

```bash
git rev-parse HEAD
test -z "$(git status --porcelain)"
git show -s --format='%H %cI %s' HEAD
```

Acceptance for the **new final application release**:

- [ ] `HEAD` is the exact final application release SHA selected after all runtime
  changes are merged.
- [ ] The checkout is clean before build.
- [ ] The immutable GitHub CI run resolves to the same application
  SHA and all required jobs are green.
- [ ] The production Docker build completes from this checkout; the image is not
  reused from a floating tag or older tree.
- [ ] The release script completes schema/bootstrap, least-privilege and
  cross-database-denial checks before replacing the serving container.

Use [`../deploy/redeploy.sh`](../deploy/redeploy.sh) as the authoritative release
path. Do not type a reviewer token into a command that will remain in shell history.

## 2 · Prove the final runtime

Use a uniquely prefixed synthetic vendor and the actual final HTTPS hostname.
Acceptance is all-or-nothing:

- [ ] Public `/health` returns `200`, `status=ok`, `store=pgvector`, and the exact
  decision + embedding IDs expected above.
- [ ] Public network-free `/ready` returns `200`, `status=ready`, with reviewer auth,
  PostgreSQL, Qwen configuration, and embedding-model compatibility healthy.
- [ ] Authenticated, admission-controlled `/ready/deep` returns `200` and a real
  embedding probe with the same embedding ID. The request header/token is never
  visible in the captured frame.
- [ ] An authenticated synthetic invoice reaches durable `PENDING`; its proposal
  carries the final decision model ID and no sink has fired.
- [ ] A fresh sample document extraction carries the final vision model ID and then
  fed the same bounded loop.
- [ ] An unauthenticated `/pending` request fails closed, while the private reviewer
  path works. Do not display the credential.
- [ ] Smoke work items and vendor-memory rows are removed through the approved cleanup
  path after capture; the media gate's fully paginated authenticated re-query proves
  zero matching PENDING residue before any canonical screenshot/manifest promotion.
- [ ] Public UI, `/health`, `/ready`, and TLS are tested after the exact deployment.
- [ ] Recheck `/docs`, the private judge path, and the proven vision flow while making
  the sanitized incognito/off-network final capture.

Do not claim a model from configuration alone. A configured model ID proves intent;
the decision and vision canaries prove the exercised paths.

## 3 · Build the sanitized proof composite

Create `demo/final-media/autopilot-alibaba-proof.png` from fresh evidence only. A
legible 16:9 composite should show:

1. exact application SHA + green immutable CI, with repository identity visible;
2. sanitized Alibaba ECS region/service context, with instance/resource/principal IDs
   removed;
3. public `/health` and `/ready` results;
4. authenticated `/ready/deep` success with the request credential/header cropped;
5. one decision canary model ID and one vision extraction model ID.

Add a small caption distinguishing the **deployed application SHA** from any later
documentation/media-only **submission HEAD**. Strip EXIF/metadata and inspect the
image at 200% zoom. Reject it if any token, secret path, real invoice, resource ID,
stale model label, stale CI run, or ambiguous SHA remains.

## 4 · Approved public wording

Only after every check above passes and the sanitized proof exists:

> Archon Autopilot is deployed on Alibaba Cloud ECS from the recorded application
> release, using `qwen-plus`, `qwen-vl-max`, and `text-embedding-v4` through the
> DashScope-compatible Qwen path. Public health/readiness and exercised decision,
> vision, and embedding canaries are shown in the release proof.

Replace model IDs in that wording only after the same-release promotion gate passes.
Never claim the SMTP recipient received a message, exactly-once recipient delivery,
universal injection detection, a real bank/ERP integration, or live-model accuracy
from the deterministic `22/22` regression.

## Private Devpost testing instructions

Put the following information only in Devpost's private testing field:

- live URL: `https://autopilot.43.106.13.19.sslip.io/`;
- reviewer token: paste the active secret directly into the private field;
- enter it into the UI's **Judge reviewer token** control, never into the URL;
- 90-second path: sample document → extract → process → inspect PENDING → amend or
  reject → inspect Decided → remove remaining demo PENDING items;
- payment and specialist review are simulated; SMTP and JSONL are configurable
  post-approval transports;
- contact route for access trouble.

Keep the app, TLS certificate, Qwen quota, database, reviewer credential, and judge
reserve available free of charge and without restriction through the end of judging:
**2026-08-11 2:00 PM PDT**. Test the private instructions from a signed-out browser
without using any locally cached credential.
