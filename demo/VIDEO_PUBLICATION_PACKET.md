# Public video publication packet

Use this only after `demo/final-media/autopilot-demo.mp4` passes the complete playback,
secret, rights, duration, and exact-release review. The official detailed rules require
the video to be publicly visible on YouTube, Vimeo, or Youku and below three minutes.

## Title

> Archon Autopilot — Human-Gated AP Agent on Qwen | Hackathon Track 4

## Description

> Archon Autopilot is a correction-aware accounts-payable agent built for Track 4 of the Global AI Hackathon Series with Qwen Cloud.
>
> Qwen reads ambiguous invoice documents, recalls persistent vendor evidence, validates finance fields, checks duplicates and amount variance, and proposes exactly one action. It then stops at a durable PENDING item. The model and four-tool MCP surface have no approval or execution authority; only an authenticated human can approve, amend, reject, or recover an action.
>
> Human corrections become evidence for later decisions: a €5,000 re-bill above a human-corrected €3,000 amount is escalated, while the compliant €3,000 control is not. No model weights are updated.
>
> Live app: https://autopilot.43.106.13.19.sslip.io
>
> MIT-licensed source: https://github.com/upgradedev/archon-qwen-autopilot
>
> Architecture: https://github.com/upgradedev/archon-qwen-autopilot/blob/main/docs/judge-architecture.svg
>
> Alibaba/Qwen code proof: https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts
>
> Technical build journey: [PUBLIC_BLOG_URL — replace after signed-out publication, or remove this line]
>
> Models: qwen-plus · qwen-vl-max · text-embedding-v4 through the DashScope-compatible Qwen path on Alibaba Cloud.
>
> Evidence boundaries: 22/22 is a tuned developer-labelled deterministic regression, not live-model accuracy. Payment and specialist review are simulated. SMTP evidence means transport acceptance, not recipient delivery; JSONL is a restart-safe local ledger, not a bank or ERP. Recognized injection patterns are advisory; autonomous execution is structurally blocked by tool separation and the human gate.

## Chapters

Use the final measured windows from `.artifacts/video-build/windows.json`. These are
the target chapter labels; adjust timestamps to the rendered file rather than copying
planned times blindly.

```text
00:00 The AP risk and Track 4 objective
00:13 Product and trust boundary
00:28 Live invoice to durable PENDING
00:52 Exact human control
01:11 A correction changes the next decision
01:34 Measured evidence, with boundaries
01:53 Structural safety under hostile input
02:14 Alibaba Cloud and exercised Qwen proof
02:34 Live, open-source close
```

## Suggested tags

```text
Qwen, Alibaba Cloud, Qwen Cloud Hackathon, AI agent, agentic AI,
human in the loop, accounts payable, fintech, MCP, pgvector, open source
```

## Thumbnail

Create a 1280×720 crop inside this repository from the reviewed live-PENDING capture.
Use no third-party logo unless permission is confirmed. Keep three readable elements:

- `ARCHON AUTOPILOT`
- `QWEN PROPOSES · HUMAN DECIDES`
- the PENDING card and human-gate boundary

Do not show a token field, personal browser chrome, tiny CI text, or an unverified
model/SHA label. Save the reviewed thumbnail under `demo/final-media/`.

## Publication acceptance

- [ ] Upload the reviewed 1920×1080 H.264/AAC file, not an intermediate render.
- [ ] Select exact **Public** visibility; do not use Private or access-request modes.
- [ ] Confirm the platform reports a duration below 3:00 and processes 1080p.
- [ ] Add or upload accurate English captions, then watch once with audio off.
- [ ] Paste the description and replace planned chapter times with measured windows.
- [ ] Use only a reviewed, rights-cleared thumbnail.
- [ ] Check title, description, captions, thumbnail, and links on mobile and desktop.
- [ ] Open the public page signed out/incognito and play from beginning to end.
- [ ] Copy the canonical public page URL into `DEVPOST_PACKET.md`'s human-owned value
  at draft time; do not hard-code an unpublished URL in Git.
