# Supply-chain lock and verification

Verified on **2026-07-15**. These pins make the executable CI/runtime inputs
reviewable and prevent mutable major tags or package-repository state from silently
changing the final submission build.

| Surface | Committed pin | Authoritative verification |
|---|---|---|
| Node runtime | `24.18.0` / npm `11.16.0` | [Node v24.18.0 LTS release](https://nodejs.org/en/blog/release/v24.18.0) and `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` |
| Production Node image | `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | Docker Registry v2 returned this OCI-index digest for the official `library/node` tag |
| CI pgvector | `pgvector/pgvector:0.8.5-pg16-bookworm@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb` | Docker Registry v2 returned this OCI-index digest for the official image tag |
| Load generator | `k6` v2.1.0 Linux AMD64 | [Official Grafana k6 release](https://github.com/grafana/k6/releases/tag/v2.1.0); tarball SHA-256 `295d961ebfca306f295f1133068dcd403a8171c87f387928f5f30b0fbcff858a` matches its published checksum manifest |
| JavaScript graph | `package-lock.json` | `npm ci`; registry tarballs are integrity-checked from the lock |
| GitHub Actions | Full 40-character commit SHAs | Human-readable exact release comments sit beside every `uses:` reference |
| Video Python graph | Python `3.11.15` plus `requirements.lock` | `pip --require-hashes --only-binary=:all:` and `pip check` |

The offline regression `npm run test:docs` fails if any setup-node patch, Node image
digest, pgvector digest, k6 version/hash, Action SHA, Python patch, or Python hash lock
drifts from this contract. `.nvmrc`, `package.json`, CI, and both Docker stages all
select the same Node patch.

## Honest residual nondeterminism

- GitHub's `ubuntu-latest` runner image and its preinstalled OS packages remain a
  moving platform. Pinning a hosted-runner VM image is not supported by this workflow.
- The production image still installs current Debian Bookworm security packages for
  `ca-certificates` and `poppler-utils`; the base OCI index is immutable, but apt
  package resolution is not snapshot-pinned.
- Playwright's browser revision is selected by the locked npm graph, while
  `playwright install --with-deps` resolves runner OS packages at execution time.
- The video job's ffmpeg/fonts/jq apt fallback and remote ElevenLabs/edge-tts audio
  generation are not bit-for-bit reproducible. Generated media is therefore reviewed
  and captured as final evidence rather than claimed as a deterministic build.

All local verification downloads and extracted runtimes belong under the ignored
project path `.artifacts/`; no supply-chain tooling or evidence is written outside
this repository.
