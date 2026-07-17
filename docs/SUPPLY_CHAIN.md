# Supply-chain lock and verification

Verified on **2026-07-17**. These pins make the executable CI/runtime inputs
reviewable and prevent mutable major tags or package-repository state from silently
changing the final submission build.

| Surface | Committed pin | Authoritative verification |
|---|---|---|
| Node runtime | `24.18.0` / npm `11.16.0` | [Node v24.18.0 LTS release](https://nodejs.org/en/blog/release/v24.18.0) and `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` |
| Build image | `node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd` | Docker Registry v2 returned this OCI-index digest for the official `library/node` tag |
| Production runtime base | `cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795` | Chainguard Registry returned this OCI-index digest; no mutable tag participates in the reference |
| Runtime requirement closure | 45 exact Wolfi package versions in `runtime-packages.lock` | Includes Node `24.18.0-r2`, Poppler `26.07.0-r0`, Ubuntu Font `0.869-r3`, and direct/transitive requirements; apk-tools 2 requests their names, then filename-set and raw-byte locks fail rather than accepting a substituted version |
| Runtime archive bytes | 45 SHA-256 entries in `runtime-apk-archives.sha256` | One canonical filename and digest for every requirement; the fetched set must match the requirement closure exactly before every raw archive is verified |
| Final installed APK inventory | 51 exact versions in `runtime-apk-inventory.lock` | Includes the 45-entry requirement closure plus six packages present only in the immutable Wolfi base; hosted `apk info -v` output must match exactly and is retained |
| CI pgvector | `pgvector/pgvector:0.8.5-pg16-bookworm@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb` | Docker Registry v2 returned this OCI-index digest for the official image tag |
| Load generator | `k6` v2.1.0 Linux AMD64 | [Official Grafana k6 release](https://github.com/grafana/k6/releases/tag/v2.1.0); tarball SHA-256 `295d961ebfca306f295f1133068dcd403a8171c87f387928f5f30b0fbcff858a` matches its published checksum manifest |
| Source analyzer | CodeQL Action v4.37.1 commit `7188fc363630916deb702c7fdcf4e481b751f97a`; bundled CLI/query bundle `2.26.1` | [Exact official Action commit](https://github.com/github/codeql-action/commit/7188fc363630916deb702c7fdcf4e481b751f97a); the commit's `defaults.json` selects `codeql-bundle-v2.26.1` |
| SBOM generator | Syft v1.46.0 Linux AMD64 | [Official Anchore Syft release](https://github.com/anchore/syft/releases/tag/v1.46.0); tarball SHA-256 `d654f678b709eb53c393d38519d5ed7d2e57205529404018614cfefa0fb2b5ca`; extracted executable SHA-256 `574df1a0862ff88ad933be214e81069e35b17618a13e019f8f1c84fe063222a2`; reviewed `.syft.yaml` SHA-256 `426021b3be44dd47ae4ca10de945f7e3fe4fd520619d5825c48e1324f925a533` |
| Image vulnerability scanner | Grype v0.115.0 Linux AMD64 | [Official Anchore Grype release](https://github.com/anchore/grype/releases/tag/v0.115.0); tarball SHA-256 `3fad92940650e514c0aa2dad83526942a055e210cec09a8a59d9c024adc2b90e`; extracted executable SHA-256 `05ffd2c28a607e48fb2269d9aac5b3d53e8a51bbac501946644745eae2119907`; reviewed `.grype.yaml` SHA-256 `5c7e79f0d60429243c7e085a483997ec0be11d0303b413bafae716c8ffae68b5` |
| Vulnerability intelligence | Grype DB schema v6.1.8, built 2026-07-15 | Exact archive URL in `.github/workflows/supply-chain.yml`; SHA-256 `0d9ac9d49c93649ea6bf713c60960b46e33c939d49ac7de52df649453d29cf8e` |
| JavaScript graph | `package-lock.json` | `npm ci`; registry tarballs are integrity-checked from the lock |
| GitHub Actions | `checkout` v7.0.0 commit `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`; `setup-node` v7.0.0 commit `820762786026740c76f36085b0efc47a31fe5020`; `setup-python` v6.3.0 commit `ece7cb06caefa5fff74198d8649806c4678c61a1`; `upload-artifact` v7.0.1 commit `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | Official releases: [checkout v7.0.0](https://github.com/actions/checkout/releases/tag/v7.0.0), [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0), [setup-python v6.3.0](https://github.com/actions/setup-python/releases/tag/v6.3.0), [upload-artifact v7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1); every reference is a full 40-character commit SHA and each pinned `action.yml` declares Node 24 |
| Video Python graph | Python `3.11.15` plus `requirements.lock` | `pip --require-hashes --only-binary=:all:` and `pip check` |
| Local promotion Poppler | Windows x64 package spec `poppler=26.05.0=h4b9d284_3`; executable SHA-256 `742cbbd9a00931ad16c6618410bc40471375d639a45c61c1d86f3dcfc54b6388`; 178-file bundle SHA-256 `26876d12591351aa880d98a4a84b7a3f9d242f043ee95716ac8198ed0f5b0e30` | Runtime is provisioned under ignored `.artifacts/supply-chain/poppler/`; every keyed artifact re-attests the package metadata, executable and complete bundle against `eval/promotion-poppler.lock.json` |

The offline regression `npm run test:docs` parses both security workflows as YAML
and validates their exact triggers, job environment allowlist, ordered step
inventory, keys, action identities, pins, gate IDs and critical step-local commands.
It rejects aliases, merge keys, duplicate/complex keys, unapproved `uses:`,
`continue-on-error`, filtering environment variables, missing gate semantics,
  unreviewed Docker parser directives/frontends, builder/resolver command drift,
  post-build compiled-output mutation, package lifecycle-hook, scanner-binary or PATH-shadow substitution,
  package/archive closure drift, post-validation Docker instructions or COPY
destinations, scanner exclusion/cataloger/ignore-policy drift, a Syft call without
its explicit reviewed config, a post-scan SBOM overwrite, and changed reviewed byte identities. The
complete SBOM hash→scan→provenance executable program is normalized and exact-locked. This avoids treating comments
or quoted lookalikes as executable controls and prevents an extra step from replacing
the image or sealed SBOM between build and scan. It also fails if any
setup-node patch, Node image digest, runtime-package version, pgvector digest, k6
version/hash, Action SHA, Python patch, or Python hash lock drifts from this
contract. `.nvmrc`, `package.json`, the build image and the runtime lock all select
Node 24.18.0. The three runtime lock files and both scanner policies are LF-only.
The hosted workflow checks their reviewed full-file SHA-256 identities before use.
The Docker context is default-deny: its exact allowlist admits only the package/npm
locks, `tsconfig`, `src`, the two production DB scripts, the three runtime locks and
the sample invoice required by reviewed `COPY` instructions. Unknown future files,
including `.artifacts` and `.env` credentials, cannot cross the Docker-daemon boundary.
The final-stage instruction/COPY allowlist then limits runtime additions to the
reviewed application paths.

## Production-image security evidence

Two independent hosted workflows cover source and artifact risk:

- `.github/workflows/codeql.yml` runs GitHub CodeQL's pinned
  `security-and-quality` query suite over the complete JavaScript/TypeScript
  revision. `CODEQL_ACTION_DIFF_INFORMED_QUERIES=false` prevents the Action's
  default PR range restriction, so the pull-request gate and `main` gate both cover
  the full submitted JavaScript/TypeScript source. It
  retains raw and GitHub-post-processed SARIF plus a sanitized summary, maps every
  result's `ruleId`/`ruleIndex` to numeric rule/result `security-severity`, and fails
  at `>= 7.0` (high/critical) with no allowlist. It also fails closed when a SARIF
  run omits its explicit result array, reports an unsuccessful invocation or an
  error execution/configuration notification, contains malformed analysis state,
  or leaves a security-tagged result without numeric security severity. Unscored
  non-security quality results remain visible in the aggregate summary. Notification text,
  locations, source snippets and result messages are never copied into the gate
  summary. The post-processed SARIF is also the evidence uploaded to GitHub code
  scanning.
- `.github/workflows/supply-chain.yml` builds the same production `Dockerfile` used
  for deployment; executes it with no network, a read-only root filesystem, dropped
  capabilities, uid/gid 1000, no npm, and a bounded `pdftoppm` render of a hash-frozen
  PDF. That render requires the four reviewed Ubuntu TTF assets to be present, emits
  a non-empty bounded PNG, and rejects any `pdftoppm` stdout or stderr—including font
  substitution diagnostics; checks APK-managed file contents and permissions with
  `apk audit --system --check-permissions` against the installed database with an
  explicitly empty repository list and networking disabled. The audit must have no
  diagnostic and its only output must be the exact directory-metadata changes for
  `/proc`, `/sys` and the hardened `/tmp`; the canary first proves those paths are
  respectively procfs, sysfs and tmpfs runtime mounts, and any other path or change
  fails the gate;
  inventories the exact build-output image with pinned Syft; verifies that all 51
  installed APKs and all 200 distinct `name@version` pairs represented by the 207
  production package-lock entries appear in the non-empty inventory; then scans that
  sealed inventory with pinned Grype and a byte-pinned vulnerability database.

The runtime package stage first requests all 45 locked names through Wolfi's signed
repository index. Because the base image's apk-tools 2 `fetch` command does not
accept version constraints, the stage then rejects any missing, extra, duplicate or
version-substituted filename and verifies every fetched raw archive against
`runtime-apk-archives.sha256`. Only
that verified local set crosses into the final runtime stage. The final installation
runs with BuildKit networking disabled and `apk --no-network`; `--allow-untrusted`
applies only to those already hash-verified local files and cannot enable unsigned
remote resolution. The build then rejects any mismatch against the complete
51-entry installed inventory. Fitness also locks the complete final-stage instruction
values, the entire network-disabled installation program, and the COPY inventory, so
application assets can land only under the reviewed `/app` destinations after package
validation; no later instruction may replace a system executable. Hosted CI inspects
and retains the actual image config, then starts the default `CMD` under the same
no-network/read-only/capability/resource constraints and probes `/health` from inside
the container.

The CodeQL artifact is retained for 30 days even when its severity gate fails. Its
summary contains only rule IDs, severities, counts, hashes, source commit and run
timestamp—never source snippets, paths, or result messages. The image's Syft JSON,
**SPDX 2.3**, **CycloneDX JSON**, provenance and hashes are uploaded before Grype can
fail, then a 30-day combined artifact adds Grype JSON, **SARIF 2.1.0**, the human-readable
report, tool/database provenance, and `SHA256SUMS`. The built image ID is carried by
an immutable step output into the runtime and Syft steps. The Syft JSON SHA-256 is
then carried by a separate step output and rechecked immediately before both Grype
invocations, binding the gate to the retained pre-scan SBOM. Extracted Syft/Grype
binaries must match independent fixed job-level SHA-256 anchors; the entire download,
extraction and comparison program is exact-locked against substitution, the hashes are
rechecked before use, and they are written into provenance. Every scanner invocation
uses that hash-anchored executable's absolute project-local path rather than PATH
resolution. Syft and Grype are each passed an explicit hash-checked
policy copied into the evidence bundle; the effective configs and policy hashes are
retained, preventing repository/home auto-discovery from silently filtering the
catalog or adding vulnerability exceptions. The Grype SARIF is
uploaded to GitHub code scanning only after the local severity gate executes. The
image release gate fails on every **high/critical** finding, including findings
without a known fix. `.grype.yaml` has **no current CVE allowlist**. The job has an
exact environment allowlist, pins `BASH_ENV=/dev/null`, rejects any unexpected
`GRYPE_*`/`SYFT_*` variable, forbids filtering flags, and requires the retained Grype
JSON `ignoredMatches` value to be absent (the pinned Grype version's zero-result
encoding) or an empty array. A null, malformed, or non-empty value fails closed.

Both evidence bundles are self-contained after download: the three runtime locks and
two scanner policies live under `input-locks/`, and every checksum path is relative
to the artifact root.
`sha256sum --check --strict SBOM-SHA256SUMS` verifies the pre-scan bundle;
`sha256sum --check --strict SHA256SUMS` verifies the combined bundle. CI executes
both verification commands before upload rather than asking a reviewer to trust an
unexercised checksum file.

The vulnerability result is only **as of 2026-07-15**, the build date of the pinned
database snapshot. Both Docker base digests, the 45-entry requirement closure, its
45 raw-archive digests, the 51-entry expected final APK inventory, npm lock,
inventory tool, scanner and database inputs are reviewed and fixed for the
source/architecture; hosted CI additionally records the actual SBOM and rejects
archive-set, APK-inventory, APK-audited file/permission, image-ID or sealed-SBOM drift. This does not claim byte-identical image rebuilds
or make the result permanently current. Refreshing the intelligence
requires one reviewed change to the exact DB URL, SHA-256 and date in the workflow,
documentation and fitness test, followed by a new hosted run. A CodeQL result belongs to the source
commit, query bundle and timestamp recorded by its retained workflow artifact; it is
dated evidence, not a timeless source claim. A green CodeQL/Grype run is evidence that
the configured checks completed; it is **not a security certification** or proof that
no vulnerability exists.

An exception is not added merely to make CI green. Any future allowlist entry must
identify the exact vulnerability and package, document reachability and compensating
controls, name an owner and expiry, and update the fitness function in the same
review. There are no such exceptions in this revision.

## Local promotion Poppler

Keyed model-promotion evidence does not trust a mutable PATH lookup or host package.
This keyed protocol is deliberately pinned to Windows x64 until a separately hashed
platform bundle is preregistered. The complete runtime must be provisioned under the
ignored project path `.artifacts/supply-chain/poppler/`; the runner resolves the real
executable, rejects symlink/path escapes, requires platform, architecture,
basename/version/package spec/executable SHA-256 and the deterministic hash of all 178 bundle
files to match `eval/promotion-poppler.lock.json`, and proves it can raster every
frozen PDF before artifact creation or any model-provider call. Raster outputs and all
promotion-time Node temporary files stay under a unique `.artifacts/` run root.
Preflight files are cleaned before provider calls; live files are cleaned and the
bundle is re-attested before a result can close as complete.

The package spec was captured from the provisioning bundle's dependency manifest;
the project copy was verified byte-for-byte against that source before the hashes
were frozen. The package spec is provenance metadata, not a vendor signature—the
executable and deterministic full-bundle hashes are the authoritative runtime lock.

## Honest residual nondeterminism

- GitHub's `ubuntu-24.04` hosted-runner label and its preinstalled Docker/OS packages
  remain a moving platform. The workflow records `docker version`; pinning the
  hosted-runner VM image itself is not supported by this workflow.
- Runtime packages are exact-version locked, which also means a newly published fix
  is not consumed until the lock is deliberately reviewed and advanced. If an exact
  signed package or its exact reviewed archive bytes disappear from the Wolfi
  repository, the image build fails closed; the archives are not vendored in Git.
  That is an availability residual, not permission for mutable dependency resolution.
- APK's system audit covers package-managed paths but excludes some protected paths
  and does not inventory arbitrary untracked files. Exact Docker instructions/COPY
  destinations and the Syft image inventory are separate controls, not proof that
  every filesystem byte is trusted or immutable.
- Playwright's browser revision is selected by the locked npm graph, while
  `playwright install --with-deps` resolves runner OS packages at execution time.
- The video job's ffmpeg/fonts/jq apt fallback and remote ElevenLabs/edge-tts audio
  generation are not bit-for-bit reproducible. Generated media is therefore reviewed
  and captured as final evidence rather than claimed as a deterministic build.
- Matching results are repeatable for the same image, Syft, Grype and advisory
  snapshot. Emitted evidence includes generation metadata, and the hosted Docker
  engine is recorded rather than claimed to produce byte-identical image IDs.

All local verification downloads and extracted runtimes belong under the ignored
project path `.artifacts/`; no supply-chain tooling or evidence is written outside
this repository.

`.github/CODEOWNERS` routes changes to the Dockerfile, security workflows, locks,
gates and their fitness tests to the repository owner. It is review-routing evidence,
not a claim that GitHub branch protection currently enforces approval.
