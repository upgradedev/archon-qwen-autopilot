# Blog-post publication and re-verification packet

Use the long-form [`BLOG.md`](BLOG.md) for the optional Blog Post bonus. The official
bonus criterion is the post's **thoroughness and potential impact**, so the full build
journey is preferable to publishing only the short social draft.

## Listing metadata

**Title**

> An accounts-payable agent you can actually trust with the money: Qwen function-calling behind a human gate

**Excerpt**

> How we built Archon Autopilot: a correction-aware Qwen agent that reads ambiguous invoices, gathers vendor evidence through bounded tools, and stops at an authenticated human gate before any consequential action.

**Suggested tags**

> Qwen · Alibaba Cloud · AI agents · human in the loop · fintech · accounts payable · MCP · open source

**Preferred cover**

> `demo/final-media/autopilot-live-intake-pending.png`, after final sanitization. Use
> `judge-architecture.jpg` if the publication layout makes the UI unreadable.

## Before publication or any public revision

- [ ] Replace the relative architecture image in `BLOG.md` with the public final
  architecture image or an uploaded copy; preview it on the destination platform.
- [ ] Preserve the canonical public video URL near the introduction and final call to action.
- [ ] Add the live app and MIT repository links exactly as listed in
  [`DEVPOST_PACKET.md`](DEVPOST_PACKET.md).
- [ ] Keep the build-journey details: why the hard human boundary matters, the single
  Qwen tool loop, the correction signal, the source-total safety guard, the discovered
  `s22` routing gap, and the honest offline/online evaluation split.
- [ ] Preserve the limitations: synthetic/developer-labelled eval, no time-and-motion
  study, simulated payment/review, SMTP acceptance rather than recipient delivery,
  and advisory rather than universal injection detection.
- [ ] Replace any “final CI” placeholder with links/numbers from the exact final
  submission commit, or omit the totals and link the immutable run.
- [ ] Use only final exact-release screenshots. No token, personal browser chrome,
  cloud ID, real invoice, or cross-entry asset may appear.
- [ ] Confirm cover, architecture, fonts, voice/video embeds, and every other asset
  have public promotional-use rights.
- [ ] Add descriptive alt text to every image.
- [ ] Preview mobile and desktop layouts, then open every link signed out.
- [ ] After publishing or editing, keep its canonical URL in the Devpost draft and
  recheck the URL signed out.

## Suggested final call to action

> Try the live, human-gated workflow at https://autopilot.43.106.13.19.sslip.io and inspect the MIT-licensed implementation at https://github.com/upgradedev/archon-qwen-autopilot. The public demo video shows the exact release moving from ambiguous document intake to a bounded Qwen proposal, human correction, and audited outcome, without giving the model authority to move money.
