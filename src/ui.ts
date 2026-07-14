// The approval UI — a single static, dependency-free HTML+JS page served by the
// SAME Fastify backend (GET / and GET /ui). It calls the real endpoints
// (/pending, /approve/:id, /amend/:id, /reject/:id) same-origin, so a human can
// work the accounts-payable approval queue in a browser: review each Qwen-proposed
// action + its reasoning + arguments, then approve, amend (edit the args inline),
// or reject.
//
// The page is a plain .html file next to this module (no build step, no bundler).
// The production image copies it beside the compiled module, and it is read once at startup.

import { readFileSync } from "node:fs";

export const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
