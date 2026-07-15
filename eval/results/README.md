# Captured online evidence

Online result JSON is written here only by explicit keyed commands:

```bash
npm run eval:live -- --write eval/results/qwen-plus-attempt-01.json
npm run eval:vision:live -- --write eval/results/qwen-vl-max-attempt-01.json
npm run eval:compare:preflight -- --runs 4 --baseline-decision qwen-plus --baseline-vision qwen-vl-max --candidate qwen3.7-plus-2026-05-26 --expected-release <exact-fetched-release-commit> --write eval/results/model-promotion-ab-attempt-02.json
npm run eval:compare:live -- --baseline-decision qwen-plus --baseline-vision qwen-vl-max --candidate qwen3.7-plus-2026-05-26 --expected-release <exact-fetched-release-commit> --write eval/results/model-promotion-ab-attempt-02.json
```

The comparison preflight is deliberately not evidence: it needs no API key, makes
zero provider calls and creates no attempt file. It proves the local environment and
committed protocol are ready before the immutable keyed attempt starts.

The standalone AP and vision runners require three complete repetitions; the keyed
comparison requires the exact four-run `AB / BA / BA / AB` protocol. All bind output
to committed fixture hashes, retain every miss and categorical error, and refuse paths
outside the repository.
The first write is a fsynced same-directory stage plus atomic no-overwrite hard link:
partial, failed, and complete attempts are never replaced and a partial target is
never published. Progress uses fsynced atomic replacement, and both paths clean their
stage and flush the directory. Register a finished attempt in `evidence-ledger.json`,
commit, and choose the exact next two-digit suffix (`01..99`) for a retry. No online
score is present until those commands complete with a real DashScope key. Offline
CI results are deliberately not stored here as model-quality evidence.

`evidence-ledger.json` is the committed append-only index of prior attempt paths,
hashes, source commits and classifications. Suffixes for each result prefix must be
contiguous from `01`. Every entry and its artifact must exist in `HEAD` as a real
regular `100644` non-symlink file with exact committed/working bytes, hash, JSON status
and provenance commit. Modified, missing, untracked or reclassified entries fail the
protocol-tree gate. During a run only the active untracked result is allowed. After
any new attempt, append its final hash and commit both before starting another.

`model-promotion-ab-attempt-01.json` is committed with forced LF as an immutable
environment-invalid diagnostic (SHA-256
`cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588`). Its five PDF
fixtures failed in both arms and all three runs because Node resolved no executable
behind the Windows PATH wrapper. Never overwrite, delete, edit, reclassify or cite
attempt 01 as model-quality evidence. It is not model-quality evidence. A hardened
retry uses a new commit and suffix.

Keyed comparison/vision evidence now requires the project-contained Windows x64
Poppler runtime, real raster preflight of every frozen PDF, safe platform,
architecture, basename/version/executable and full-bundle SHA-256 provenance, and a
unique repository-contained temporary root. Preflight output is cleaned before
provider calls; live output is cleaned and the bundle re-attested before completion.
