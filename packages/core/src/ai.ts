/**
 * The model that writes summaries and finds action items: Anthropic, OpenAI,
 * Google Gemini, or any server that speaks OpenAI's chat completions (Ollama,
 * LM Studio, OpenRouter, vLLM). Each is asked to call one tool, so the answer
 * comes back as JSON in the shape we asked for.
 */
import { setting } from "./settings";

export const AI_PROVIDERS = ["anthropic", "openai", "gemini", "custom"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_NAMES: Record<AiProvider, string> = { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini", custom: "Your model" };

export function aiProvider(): AiProvider {
  const p = setting("AI_PROVIDER") as AiProvider;
  return AI_PROVIDERS.includes(p) ? p : "anthropic";
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** The key, model and address for the chosen provider. */
export function aiConfig(provider = aiProvider()) {
  switch (provider) {
    case "anthropic":
      return { provider, key: setting("ANTHROPIC_API_KEY"), model: setting("ANTHROPIC_MODEL"), baseUrl: "https://api.anthropic.com/v1" };
    case "openai":
      return { provider, key: setting("OPENAI_API_KEY"), model: setting("OPENAI_MODEL"), baseUrl: "https://api.openai.com/v1" };
    case "gemini":
      return { provider, key: setting("GEMINI_API_KEY"), model: setting("GEMINI_MODEL"), baseUrl: GEMINI_URL };
    case "custom":
      return { provider, key: setting("AI_API_KEY"), model: setting("AI_MODEL"), baseUrl: setting("AI_BASE_URL").replace(/\/+$/, "") };
  }
}

/** Whether summaries can be written here: a key (or, for your own server, an address and a model). */
export function aiConfigured() {
  const c = aiConfig();
  return c.provider === "custom" ? !!(c.baseUrl && c.model) : !!(c.key && c.model);
}

/** "Claude (claude-sonnet-5-5)", for status lines. */
export const aiLabel = () => `${AI_PROVIDER_NAMES[aiProvider()]} (${aiConfig().model || "no model"})`;

export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> };

/** JSON Schema without the keys some OpenAI-compatible servers (Gemini's among them) refuse. */
export function plainSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(plainSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => k !== "$schema" && k !== "additionalProperties")
      .map(([k, v]) => [k, plainSchema(v)])
  );
}

/** The request each provider expects, as fetch arguments. Exported for the tests. */
export function toolRequest(
  c: ReturnType<typeof aiConfig>,
  req: { system: string; user: string; tool: ToolSpec; maxTokens: number }
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (c.provider === "anthropic")
    return {
      url: `${c.baseUrl}/messages`,
      headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": "2023-06-01" },
      body: {
        model: c.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.schema }],
        tool_choice: { type: "tool", name: req.tool.name },
        messages: [{ role: "user", content: req.user }],
      },
    };
  return {
    url: `${c.baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
    body: {
      model: c.model,
      // OpenAI's newer models take max_completion_tokens; other servers mostly ignore it, so leave it to them.
      ...(c.provider === "openai" ? { max_completion_tokens: req.maxTokens } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      tools: [
        {
          type: "function",
          function: { name: req.tool.name, description: req.tool.description, parameters: c.provider === "openai" ? req.tool.schema : plainSchema(req.tool.schema) },
        },
      ],
      tool_choice: { type: "function", function: { name: req.tool.name } },
    },
  };
}

type AnthropicReply = { content?: { type: string; name?: string; input?: unknown }[]; error?: { message?: string } };
type OpenAiReply = {
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
  error?: { message?: string } | string;
};

/** What the model passed to the tool, from either kind of reply. Exported for the tests. */
export function toolInput(provider: AiProvider, body: unknown, tool: string): unknown {
  if (provider === "anthropic") return (body as AnthropicReply)?.content?.find((c) => c.type === "tool_use" && c.name === tool)?.input;
  const msg = (body as OpenAiReply)?.choices?.[0]?.message;
  const call = msg?.tool_calls?.find((t) => !t.function?.name || t.function.name === tool) ?? msg?.tool_calls?.[0];
  // A local model that can't call tools may still answer with the JSON itself.
  const raw = call?.function?.arguments ?? msg?.content?.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function errorText(body: unknown, status: number) {
  const e = (body as { error?: { message?: string } | string } | null)?.error;
  return (typeof e === "string" ? e : e?.message) ?? `HTTP ${status}`;
}

/** Asks the model to call `tool` and returns what it passed. */
export async function callTool(req: { system: string; user: string; tool: ToolSpec; maxTokens?: number; timeoutMs?: number }) {
  const c = aiConfig();
  const name = c.provider === "custom" ? "Your server" : AI_PROVIDER_NAMES[c.provider];
  if (!aiConfigured()) throw new Error(`Set up an AI provider in Settings → AI summaries first, or ask your assistant through the MCP server.`);
  const r = toolRequest(c, { ...req, maxTokens: req.maxTokens ?? 8000 });
  let res: Response;
  try {
    res = await fetch(r.url, { method: "POST", headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(req.timeoutMs ?? 180_000) });
  } catch (err) {
    throw new Error(`${name}: couldn't reach ${new URL(r.url).host} (${(err as Error).message}).`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${name}: ${errorText(body, res.status)}`);
  const input = toolInput(c.provider, body, req.tool.name);
  if (input === undefined) throw new Error(`${name} answered without the notes. Try another model: ${c.model} may not support tool calls.`);
  return input;
}

/** A tiny request, to check the key and model before a meeting needs them. */
export async function testAi() {
  const started = Date.now();
  const out = await callTool({
    system: "You are checking that a connection works.",
    user: 'Call the tool with ok set to true.',
    tool: { name: "report", description: "Report that the connection works.", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
    maxTokens: 200,
    timeoutMs: 60_000,
  });
  if (!(out as { ok?: unknown })?.ok) throw new Error(`${AI_PROVIDER_NAMES[aiProvider()]} answered, but not as expected.`);
  return { model: aiConfig().model, ms: Date.now() - started };
}
