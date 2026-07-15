# Captured online evidence

Online result JSON is written here only by explicit keyed commands:

```bash
npm run eval:live -- --write eval/results/qwen-plus-attempt-01.json
npm run eval:vision:live -- --write eval/results/qwen-vl-max-attempt-01.json
npm run eval:compare:live -- --baseline-decision qwen-plus --baseline-vision qwen-vl-max --candidate qwen3.7-plus-2026-05-26 --write eval/results/model-promotion-ab-attempt-01.json
```

Both runners require three complete repetitions, bind output to committed fixture
hashes, retain every miss and categorical error, and refuse paths outside the repository.
The first write is exclusive: partial, failed, and complete attempts are never
overwritten; progress uses fsynced atomic replacement so the authoritative attempt
stays parseable across crashes. Archive it and choose `attempt-02`, etc. for a retry. No online
score is present until those commands complete with a real DashScope key. Offline
CI results are deliberately not stored here as model-quality evidence.
