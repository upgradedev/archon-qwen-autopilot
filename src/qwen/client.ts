// Qwen client — one OpenAI-compatible entry point to Alibaba Cloud Model Studio
// (DashScope). Both the embedder and the function-calling decider talk to Qwen
// through the same OpenAI-compatible surface, so the standard `openai` SDK
// connects unchanged — exactly as the hackathon getting-started guide prescribes.
//
// Auth + endpoint come from the environment:
//   DASHSCOPE_API_KEY  — Model Studio API key (absent → offline Fakes are used)
//   DASHSCOPE_BASE_URL — OpenAI-compatible base URL; defaults to the hackathon
//                        international endpoint.
//
// The minimal interfaces below are the ONLY surface the embedder + decider need.
// The real OpenAI client satisfies them, and small canned fakes satisfy them in
// tests — so EVERY code path (including the tool-call parse) runs offline.

import OpenAI from "openai";

export const DEFAULT_BASE_URL =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export interface OfficialEvidenceEndpoint {
  baseUrl: string;
  region: "international" | "china-beijing";
}

export interface OfficialRuntimeEndpoint {
  baseUrl: string;
  region: "cn-beijing" | "ap-southeast-1" | "eu-central-1" | "ap-northeast-1" | "cn-hongkong" | "us-east-1";
  access: "dashscope" | "workspace-dedicated";
}

function normalizedEndpoint(value: string, context: string): URL {
  // URL() is intentionally forgiving: it trims surrounding ASCII whitespace and
  // represents a bare trailing `?`/`#` as an empty search/hash. Production config
  // must be byte-for-byte explicit so those ambiguous spellings fail closed.
  if (value !== value.trim() || value.includes("?") || value.includes("#")) {
    throw new Error(`${context} requires a credential-free HTTPS Model Studio base URL on the default port`);
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${context} requires a valid official Model Studio base URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error(`${context} requires a credential-free HTTPS Model Studio base URL on the default port`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

// Production accepts only documented pay-as-you-go Model Studio domains: the
// shared DashScope endpoints or a workspace-dedicated `llm-*` host in a known
// Model Studio region. Trial, Token Plan, Coding Plan and arbitrary compatible
// proxies are deliberately excluded from this backend runtime.
export function officialRuntimeEndpoint(value: string = DEFAULT_BASE_URL): OfficialRuntimeEndpoint {
  const url = normalizedEndpoint(value, "production runtime");
  const shared = new Map<string, OfficialRuntimeEndpoint["region"]>([
    ["dashscope.aliyuncs.com", "cn-beijing"],
    ["dashscope-intl.aliyuncs.com", "ap-southeast-1"],
    ["cn-hongkong.dashscope.aliyuncs.com", "cn-hongkong"],
    ["dashscope-us.aliyuncs.com", "us-east-1"],
  ]);
  const sharedRegion = shared.get(url.hostname);
  if (sharedRegion && url.pathname === "/compatible-mode/v1") {
    return { baseUrl: `${url.origin}${url.pathname}`, region: sharedRegion, access: "dashscope" };
  }
  const workspace = /^(llm-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)\.(cn-beijing|ap-southeast-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.exec(url.hostname);
  if (workspace && url.pathname === "/compatible-mode/v1") {
    return {
      baseUrl: `${url.origin}${url.pathname}`,
      region: workspace[2] as OfficialRuntimeEndpoint["region"],
      access: "workspace-dedicated",
    };
  }
  throw new Error("production runtime permits only official pay-as-you-go Alibaba Model Studio endpoints");
}

// Keyed benchmark evidence and production runtime both attest that they target
// Alibaba Model Studio, not an arbitrary OpenAI-compatible proxy. Non-production
// tests may still inject a fake-compatible endpoint through the client seam.
export function officialEvidenceEndpoint(value: string = DEFAULT_BASE_URL): OfficialEvidenceEndpoint {
  const url = normalizedEndpoint(value, "online evidence");
  const normalized = `${url.origin}${url.pathname}`;
  if (normalized === "https://dashscope-intl.aliyuncs.com/compatible-mode/v1") {
    return { baseUrl: normalized, region: "international" };
  }
  if (normalized === "https://dashscope.aliyuncs.com/compatible-mode/v1") {
    return { baseUrl: normalized, region: "china-beijing" };
  }
  throw new Error("online evidence permits only official Alibaba Model Studio endpoints");
}

// True when a real Model Studio key is configured. Drives the auto-selection of
// real Qwen vs. the deterministic offline Fakes (embedder + chat client), so dev
// and CI run with zero credentials and zero spend.
export function hasQwenCreds(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

// Robustness defaults for every live call to DashScope: a per-request timeout so a
// hung upstream cannot stall the ReAct loop indefinitely, and a small automatic
// retry budget for transient network / 5xx blips. Overridable via env for tuning.
export const QWEN_REQUEST_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS || 20_000);
export const QWEN_MAX_RETRIES = Number(process.env.QWEN_MAX_RETRIES || 2);

export function createQwenClient(
  apiKey: string = process.env.DASHSCOPE_API_KEY ?? "",
  baseURL: string = DEFAULT_BASE_URL
): OpenAI {
  const effectiveBaseUrl = process.env.NODE_ENV === "production"
    ? officialRuntimeEndpoint(baseURL).baseUrl
    : baseURL;
  return new OpenAI({
    apiKey,
    baseURL: effectiveBaseUrl,
    timeout: QWEN_REQUEST_TIMEOUT_MS,
    maxRetries: QWEN_MAX_RETRIES,
  });
}

// ── Embeddings seam ───────────────────────────────────────────────────────────

export interface EmbeddingsCreateArgs {
  model: string;
  input: string;
  dimensions?: number;
}
export interface EmbeddingsResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}
export interface QwenEmbeddingsClient {
  embeddings: {
    create(args: EmbeddingsCreateArgs, opts?: { signal?: AbortSignal }): Promise<EmbeddingsResponse>;
  };
}

// ── Chat + function-calling seam ──────────────────────────────────────────────
// These shapes mirror the OpenAI-compatible chat-completions tool-calling API
// that DashScope exposes for qwen-plus. The real `openai` client satisfies them,
// and FakeQwenChatClient (below) returns canned assistant messages carrying
// `tool_calls`, so the decider's REAL tool-call parse path is exercised offline.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

// A function tool the model may call (OpenAI-compatible `tools[]` element).
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema for the arguments
  };
}

// A tool call the model chose. `arguments` is a JSON STRING (OpenAI contract),
// which the decider parses back into an object.
export interface ToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCreateArgs {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  response_format?: { type: "json_object" };
  // Alibaba's Node/OpenAI-compatible contract requires this at the request-body
  // top level. (`extra_body` is the Python SDK spelling and is not used here.)
  enable_thinking?: boolean;
}

export const SOTA_CANDIDATE_MODEL = "qwen3.7-plus-2026-05-26";
export function requiresNonThinkingJsonOrTools(model: string): boolean {
  return model === SOTA_CANDIDATE_MODEL;
}

export interface ChatResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// The optional per-request options the loop passes alongside the body. Only `signal`
// is used (to abort a call the wall-clock deadline has passed); it mirrors the real
// `openai` client's second argument, so passing it through is a no-op for the Fakes.
export interface ChatRequestOptions {
  signal?: AbortSignal;
}

export interface QwenChatClient {
  chat: {
    completions: {
      create(args: ChatCreateArgs, opts?: ChatRequestOptions): Promise<ChatResponse>;
    };
  };
}

export function chatClient(): QwenChatClient {
  return createQwenClient() as unknown as QwenChatClient;
}
