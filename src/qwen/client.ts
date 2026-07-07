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
  return new OpenAI({
    apiKey,
    baseURL,
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
}
export interface QwenEmbeddingsClient {
  embeddings: { create(args: EmbeddingsCreateArgs): Promise<EmbeddingsResponse> };
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
}

export interface ChatResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
  }>;
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
