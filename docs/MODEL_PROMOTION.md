# Frozen model-promotion protocol

The production rollback pair remains `qwen-plus` for AP tool calling and
`qwen-vl-max` for document extraction. `qwen3.7-plus-2026-05-26` is a versioned,
high-upside candidate, never a silent replacement.

## Preregistration boundary

1. Finish and review the protocol, fixtures, policy and runner changes.
2. Run the offline checks and full repository verification.
3. Commit the complete tree. Confirm `git status --porcelain` is empty.
4. Record the commit and protocol hash printed by the counterbalanced runner.
5. Only then run keyed evidence. The online runner refuses a dirty/uncommitted
   protocol tree, anything other than the four preregistered repetitions, an artifact
   path outside this repo, a non-sequential suffix outside `01..99`, or replacement
   of any prior partial/failed/complete attempt.
6. The runners also reject custom/proxy hosts before the first call. Each artifact
   attests the normalized official Model Studio endpoint and region (never the key).
7. Keyed promotion additionally requires the locked Windows x64 `pdftoppm` bundle under this
   repository's ignored `.artifacts/supply-chain/poppler/` tree. A PATH command,
   shell wrapper, symlink escape or system-wide binary is ineligible evidence.

The exact files bound into each protocol hash are emitted in the artifact under
`provenance.files`; that list, not prose copied into a post, is authoritative.

## Promotion-environment preflight

Provision the complete Poppler runtime bundle under the project before keyed
evidence. The pinned executable locator is
`.artifacts/supply-chain/poppler/Library/bin/pdftoppm.exe`. This protocol is
intentionally Windows x64-only until another platform bundle is separately locked.

`POPPLER_PDFTOPPM` may select another path only when its resolved real file remains
inside this repository. Before an evidence artifact exists—and before any provider
call—the runner executes the real binary, attests safe platform/architecture,
basename, parsed version, package spec, executable SHA-256, full-bundle file
count/SHA-256, and
rasterizes every frozen PDF. Outputs are validated as bounded PNGs under the
repository's ignored `.artifacts/` directory and are removed before the first
provider request. A unique live-run temp root is emptied and removed, and the whole
bundle is re-attested, before the artifact can close. Unexpected residual files fail
the attempt even though the runner still removes them as a privacy best effort. Fixed
`PromotionEnvironmentError` codes fail closed without persisting an absolute path
or raw process diagnostic.

The artifact also records—and keyed promotion requires the committed values of—the
effective Qwen request timeout, SDK retry budget,
maximum attempts, vision timeout and Poppler timeout. Error cases retain measured
wall-clock latency; missing values are never converted into fictitious zero-latency
success. Fixture-set identity is computed by the same canonical LF/order/whitespace
normalizer in the comparison and standalone vision runners.

## Immutable environment-invalid attempt 01

`model-promotion-ab-attempt-01.json` is an immutable environment-invalid diagnostic,
not promotion evidence. It was produced from commit
`69e926748bb5e97ff5bc7d7cb69b6c9f8cd88e42`, has SHA-256
`cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588`, and correctly
closed as `incomplete`/`promotion.pass=false`. All 30 PDF-arm errors came from a
Windows PATH `.cmd` wrapper that Node could not spawn, rather than either vision
model. Its candidate decision error burst remains useful diagnostic evidence but
cannot rescue the invalid environment.

Attempt 01 must never be overwritten, deleted, edited, reclassified or presented as
a model-quality win. The hardened protocol starts at a new commit and a new
attempt-qualified filename; both artifacts remain available to reviewers.

The committed `eval/results/evidence-ledger.json` binds attempt 01's path, hash,
source commit, terminal status and diagnostic classification without modifying its
original bytes. Before a later keyed run, any untracked prior result must match a
ledger entry byte-for-byte; an unregistered or edited result blocks execution.

## Counterbalanced same-attempt command

The promotion decision uses one exclusive artifact with four preregistered run starts
`AB / BA / BA / AB`. Within every run and surface, each case is paired back-to-back and
the first caller alternates by case. Because both surfaces have even case counts,
each model is first exactly 11/22 decision pairs and 8/16 vision pairs in every run.
This keeps commit, endpoint, fixture set and wall-clock window together while
materially reducing transient-window and first/second-arm bias.

First run the zero-provider-call readiness command. It requires no API key, creates
no attempt JSON, and safely reports the next path, clean committed protocol hash,
official endpoint, pinned runtime, frozen-set hashes and real Poppler raster/cleanup
attestation:

```powershell
npm run eval:compare:preflight -- `
  --runs 4 `
  --baseline-decision qwen-plus `
  --baseline-vision qwen-vl-max `
  --candidate qwen3.7-plus-2026-05-26 `
  --write eval/results/model-promotion-ab-attempt-02.json
```

Only after that command returns `status: "passed"`, run the keyed comparison:

```powershell
npm run eval:compare:live -- `
  --baseline-decision qwen-plus `
  --baseline-vision qwen-vl-max `
  --candidate qwen3.7-plus-2026-05-26 `
  --write eval/results/model-promotion-ab-attempt-02.json
```

If an attempt is interrupted or incomplete, keep its JSON unchanged, append its hash
to the evidence ledger, commit, and use the exact next two-digit suffix (`01..99`).
Gaps, repeated suffixes and three-or-more-digit suffixes fail closed. Every progress
checkpoint is a fsynced same-directory atomic replacement:
a crash may leave a `.next-*` temp sibling but cannot truncate the authoritative
attempt JSON. Verify the authoritative JSON first, then remove only that orphan temp
sibling before retrying; unregistered dirty files correctly block keyed evidence.

The individual `eval:live` and `eval:vision:live` runners remain useful for diagnosis,
but separate sequential artifacts are not sufficient promotion evidence because their
time/order effects are not counterbalanced.

For candidate tool/JSON paths the implementation explicitly sets
`enable_thinking=false`; the candidate vision JSON request also omits
`max_tokens`, as required by that API path. Tests pin both request shapes.

## Promotion gates

Promote only when the artifact's machine-readable `promotion.pass` is true and a
reviewer confirms all of the following:

- the project-contained Poppler preflight passed for every frozen PDF before the
  first provider call and its safe binary attestation is present;
- all four paired runs and both arms are `complete`; provider errors and fallbacks
  remain in the fixed denominators and are not hidden; completeness never suppresses
  the remaining independently computable gate failures;
- AP argument-execution sanity is 100%, no new policy-override class appears, raw
  terminal-tool agreement is non-inferior to the rollback model in every run **and
  at least 20/22 (90.9%) in every candidate run**; candidate decision instability
  is exactly zero across the four repetitions;
- Qwen-VL normalized-string, numeric accuracy, safe-review specificity and
  safe-review balanced accuracy are non-inferior in every run; string and numeric
  accuracy are each at least 95%, recall is exactly 100%, specificity is at least
  11/12 and balanced accuracy is at least 23/24 in every candidate run,
  completion remains 16/16 per run, and at most one candidate vision case is unstable;
- for both decision and vision, the candidate's error-inclusive mean wall-clock
  latency is no more than 30,000 ms and no more than 1.5× the paired baseline mean
  in every run; missing or non-finite latency fails the gate rather than becoming zero;
- a reviewer inspects every AP miss, policy override, unstable case and vision miss
  for semantic/tool-argument validity, raw source-field uncertainty and safe-review
  reasons, not just aggregate score;
- the post-deploy `npm run smoke:submission` canary identifies live (non-Fake)
  vision, decision and embedding models, reaches PENDING, and cleans itself up via
  authenticated rejection;
- any separately measured cost is acceptable for the judging workflow; no cost is
  inferred from SDK retries or provider usage the seams do not expose.

The AP runner reports USD only when captured tokens and all caller-supplied dated
rates are present. For the International deployment, Alibaba Cloud's official
[Model Studio pricing page](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
(last updated 2026-07-08) lists the versioned candidate at 0–256K input tokens as
$0.40/M input and $1.60/M output in non-thinking mode. Image tokens count as input.
Transparent SDK retry attempts are not inferred as known cost; the vision seam
therefore leaves cost null when provider usage is unavailable.

Production runtime accepts documented pay-as-you-go shared DashScope domains and
workspace-dedicated `llm-*.<region>.maas.aliyuncs.com` domains without logging the
workspace identifier. The immutable promotion artifact is intentionally stricter:
it accepts only the shared International or Beijing evidence endpoint so no private
workspace identifier is persisted in a repository artifact. Trial, Token Plan,
Coding Plan and arbitrary compatible proxies are ineligible for both paths.

## Rollback

Restore `QWEN_MODEL=qwen-plus` and `VISION_MODEL=qwen-vl-max`, redeploy the same
commit/configuration, then run the submission smoke again. The defaults in code and
`.env.example` stay on this rollback pair until a frozen A/B clears every gate.
