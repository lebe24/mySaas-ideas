import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isFollowUpMessage } from "@/lib/chat-utils";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

type ChatMessage = { role: "user" | "assistant"; content: string };

// Re-use SDK types for everything that touches the Anthropic API
type MessageParam       = Anthropic.MessageParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type ToolUseBlock       = Anthropic.ToolUseBlock;
type TextBlock          = Anthropic.TextBlock;

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for real-time information. Use proactively when the user asks about: " +
      "market size, competitor pricing, recent news, SaaS tool reviews, revenue data, " +
      "startup launches, industry trends, or anything that benefits from up-to-date facts. " +
      "Prefer specific queries over vague ones.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A specific, targeted search query. E.g. 'Taplio LinkedIn tool pricing 2024' not just 'LinkedIn tools'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch and read the full text content of a specific web page. " +
      "Use after web_search when a result URL looks like it contains detailed, relevant information " +
      "(pricing pages, blog posts, product pages, news articles). Do not fetch homepage URLs.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL to fetch, must start with https:// or http://",
        },
      },
      required: ["url"],
    },
  },
];

// ─── Utility helpers ──────────────────────────────────────────────────────────

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m: unknown): m is { role: string; content: string } =>
        typeof m === "object" &&
        m !== null &&
        "role" in m &&
        "content" in m &&
        ((m as { role: string }).role === "user" ||
          (m as { role: string }).role === "assistant") &&
        typeof (m as { content: unknown }).content === "string",
    )
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("172.16.")
    )
      return true;
    return false;
  } catch {
    return true;
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolWebSearch(query: string): Promise<string> {
  try {
    const response = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
      { cache: "no-store" },
    );
    if (!response.ok) return `Search failed: HTTP ${response.status}`;

    const xml = await response.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
    if (items.length === 0) return `No results found for: "${query}"`;

    const results = items
      .map((item) => {
        const block = item[1] ?? "";
        const title = htmlToText(
          block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "",
        );
        const url =
          block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
        const desc = htmlToText(
          block.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? "",
        );
        if (!title || !url) return null;
        return `Title: ${title}\nURL: ${url}\nSnippet: ${desc.slice(0, 250)}`;
      })
      .filter(Boolean);

    return `Search results for "${query}":\n\n${results.join("\n\n---\n\n")}`;
  } catch (e) {
    return `Search error: ${e instanceof Error ? e.message : "Unknown error"}`;
  }
}

async function toolWebFetch(url: string): Promise<string> {
  if (isBlockedUrl(url)) return "Error: Blocked or invalid URL.";
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StarterIdeaBot/1.0)" },
    });
    if (!response.ok) return `Fetch failed: HTTP ${response.status} for ${url}`;
    const html = await response.text();
    const text = htmlToText(html).slice(0, 6000);
    return `Content from ${url}:\n\n${text}`;
  } catch (e) {
    return `Fetch error: ${e instanceof Error ? e.message : "Unknown error"}`;
  }
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return "Error: query parameter is required.";
    return toolWebSearch(query);
  }
  if (name === "web_fetch") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return "Error: url parameter is required.";
    return toolWebFetch(url);
  }
  return `Error: Unknown tool "${name}"`;
}

// ─── SDK call helper ──────────────────────────────────────────────────────────

async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  messages: MessageParam[],
): Promise<Anthropic.Message> {
  // Use beta.messages for prompt-caching support (system as array with cache_control)
  return client.beta.messages.create(
    {
      model: MODEL,
      max_tokens: 2048,
      temperature: 0.4 as never, // temperature accepted but not in beta type
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages,
    },
    {
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
    },
  ) as Promise<Anthropic.Message>;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages  = (body as { messages?: unknown }).messages;
  const systemPrompt = (body as { systemPrompt?: unknown }).systemPrompt;

  if (!Array.isArray(messages) || typeof systemPrompt !== "string") {
    return NextResponse.json(
      { error: "messages (array) and systemPrompt (string) are required" },
      { status: 400 },
    );
  }

  const chatMessages     = sanitizeMessages(messages);
  const latestUserMsg    = [...chatMessages].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastAssistantMsg = [...chatMessages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const hasHistory       = chatMessages.some((m) => m.role === "assistant");

  // Initialise the Anthropic SDK client
  const client = new Anthropic({ apiKey });

  // Build the messages array using SDK types
  const apiMessages: MessageParam[] = chatMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // ─── Fast path: conversational follow-ups ────────────────────────────────
  // Skips the agentic loop for short follow-ups that don't need web research.
  // Source-link requests are only fast-pathed if the prior response has real URLs.
  const followUp = isFollowUpMessage(latestUserMsg, hasHistory, lastAssistantMsg);

  if (followUp) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text:
              `${systemPrompt}\n\nNote: you have web search capabilities and may have cited URLs ` +
              `in earlier turns of this conversation. If the user asks for source links or references, ` +
              `extract them from your previous responses.`,
            cache_control: { type: "ephemeral" },
          } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } },
        ],
        messages: apiMessages,
      });

      const reply = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      return NextResponse.json({ reply: reply || "No response generated." });
    } catch (err) {
      const msg = err instanceof Anthropic.APIError ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  // ─── Agentic path: research questions ────────────────────────────────────
  const fullSystem = `${systemPrompt}

<web_tools>
You have two tools: web_search and web_fetch.

MANDATORY — you MUST call web_search before answering when the user asks about:
- "top players", "best tools", "leading products", "who are the main competitors"
- any specific company, product, or software by name
- pricing, plans, or revenue of any tool
- market size, market leaders, or industry comparisons
- recent news, launches, or trends
- anything you would otherwise answer from general/training knowledge

DO NOT rely on training data for company or product information — it may be outdated.
ALWAYS search first, then answer with cited URLs.

After searching, fetch the most relevant URL for full details.
Every factual claim about a real product or company must include its source URL.
</web_tools>`;

  try {
    let toolRounds = 0;

    while (true) {
      const activeSystem =
        toolRounds >= MAX_TOOL_ROUNDS
          ? `${fullSystem}\n\n<instruction>Research complete. Do NOT call any more tools. Write your complete answer now using what you have gathered.</instruction>`
          : fullSystem;

      const response = await callClaude(client, activeSystem, apiMessages);

      // ── Model finished ──────────────────────────────────────────────
      if (response.stop_reason === "end_turn") {
        const reply = response.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

        if (!reply) {
          return NextResponse.json(
            { error: "Model completed without a text response." },
            { status: 502 },
          );
        }
        return NextResponse.json({ reply });
      }

      // ── Tool use round ──────────────────────────────────────────────
      if (response.stop_reason === "tool_use") {
        // Append the assistant turn to the conversation history
        apiMessages.push({ role: "assistant", content: response.content });

        // Run all tool calls in this round in parallel
        const toolCalls = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        const toolResults: ToolResultBlockParam[] = await Promise.all(
          toolCalls.map(async (block) => ({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: await executeTool(
              block.name,
              block.input as Record<string, unknown>,
            ),
          })),
        );

        apiMessages.push({ role: "user", content: toolResults });
        toolRounds++;
        continue;
      }

      // ── Fallback ────────────────────────────────────────────────────
      const reply = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      return NextResponse.json({ reply: reply || "No response generated." });
    }
  } catch (err) {
    // Surface rate-limit errors as a readable message
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        {
          error:
            "I'm doing a lot of web research right now and hit a short-term rate limit. " +
            "Please wait 30–60 seconds and try again.",
        },
        { status: 429 },
      );
    }
    const message = err instanceof Error ? err.message : "Failed to execute agent query";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
