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
   protocol tree, fewer than three repetitions, an artifact path outside this repo,
   or replacement of any prior partial/failed/complete attempt.
6. The runners also reject custom/proxy hosts before the first call. Each artifact
   attests the normalized official Model Studio endpoint and region (never the key).

The exact files bound into each protocol hash are emitted in the artifact under
`provenance.files`; that list, not prose copied into a post, is authoritative.

## Counterbalanced same-attempt command

The promotion decision uses one exclusive artifact and alternates arm order
`AB / BA / AB`. Each arm runs both the 22-case AP decision benchmark and the
16-document vision benchmark. This keeps commit, endpoint, fixture set and wall-clock
window together and reduces first/second-arm temporal bias.

```powershell
npm run eval:compare:live -- `
  --baseline-decision qwen-plus `
  --baseline-vision qwen-vl-max `
  --candidate qwen3.7-plus-2026-05-26 `
  --write eval/results/model-promotion-ab-attempt-01.json
```

If an attempt is interrupted or incomplete, keep its JSON unchanged and increment
the suffix. Every progress checkpoint is a fsynced same-directory atomic replacement:
a crash may leave an ignorable temp sibling but cannot truncate the authoritative
attempt JSON. Existing result JSONs are the only dirty paths allowed for a retry.

The individual `eval:live` and `eval:vision:live` runners remain useful for diagnosis,
but separate sequential artifacts are not sufficient promotion evidence because their
time/order effects are not counterbalanced.

For candidate tool/JSON paths the implementation explicitly sets
`enable_thinking=false`; the candidate vision JSON request also omits
`max_tokens`, as required by that API path. Tests pin both request shapes.

## Promotion gates

Promote only when the artifact's machine-readable `promotion.pass` is true and a
reviewer confirms all of the following:

- all three paired runs and both arms are `complete`; provider errors and fallbacks remain in the fixed
  denominators and are not hidden;
- AP argument-execution sanity is 100%, no new policy-override class appears, raw
  terminal-tool agreement is non-inferior to the rollback model in every run **and
  at least 20/22 (90.9%) in every candidate run**; candidate decision instability
  is exactly zero across the three repetitions;
- Qwen-VL normalized-string and numeric accuracy are non-inferior in every run,
  each is at least 95% in every candidate run, safe-review recall is exactly 100%,
  completion remains 16/16 per run, and at most one candidate vision case is unstable;
- a reviewer inspects every AP miss, policy override, unstable case and vision miss
  for semantic/tool-argument validity, not just aggregate score;
- the post-deploy `npm run smoke:submission` canary identifies live (non-Fake)
  vision, decision and embedding models, reaches PENDING, and cleans itself up via
  authenticated rejection;
- latency and measured cost are acceptable for the judging workflow.

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
