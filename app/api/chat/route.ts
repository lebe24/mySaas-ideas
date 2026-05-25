import { NextRequest, NextResponse } from "next/server";

const MODEL = "claude-sonnet-4-20250514";

const SEARCH_STOPWORDS = new Set([
  "give", "tell", "show", "what", "when", "where", "why", "how",
  "with", "about", "please", "recent", "latest",
]);

type ChatMessage = { role: "user" | "assistant"; content: string };

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m: unknown): m is { role: string; content: string } =>
        typeof m === "object" &&
        m !== null &&
        "role" in m &&
        "content" in m &&
        ((m as { role: string }).role === "user" || (m as { role: string }).role === "assistant") &&
        typeof (m as { content: unknown }).content === "string",
    )
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
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
    if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.16.")) return true;
    return false;
  } catch {
    return true;
  }
}

async function webSearch(query: string) {
  const response = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Web search failed (${response.status})`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
  const results = items
    .map((item) => {
      const block = item[1] ?? "";
      const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
      const url = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      if (!title || !url) return null;
      return { title: htmlToText(title), url };
    })
    .filter((r): r is { title: string; url: string } => Boolean(r));

  return { query, results };
}

async function webFetchPage(url: string) {
  if (isBlockedUrl(url)) throw new Error("Blocked or invalid URL.");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Web fetch failed (${response.status})`);
  const html = await response.text();
  const text = htmlToText(html).slice(0, 5000);
  return { url, content: text };
}

async function buildWebContext(query: string): Promise<string> {
  if (!query.trim()) return "";
  const searchQuery = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !SEARCH_STOPWORDS.has(word))
    .slice(0, 8)
    .join(" ");
  try {
    const search = await webSearch(searchQuery || query);
    const top = search.results.slice(0, 3);
    const fetched = await Promise.all(
      top.map(async (result) => {
        try {
          const page = await webFetchPage(result.url);
          return `Source: ${result.url}\nSnippet: ${result.title}\nExtract: ${page.content.slice(0, 900)}`;
        } catch {
          return `Source: ${result.url}\nSnippet: ${result.title}\nExtract: (fetch failed)`;
        }
      }),
    );
    return [
      `Web search query: ${searchQuery || query}`,
      ...fetched.map((item, idx) => `Result ${idx + 1}\n${item}`),
    ].join("\n\n");
  } catch {
    return "WEB_CONTEXT_ERROR: live web search/fetch failed for this request.";
  }
}

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

  const messages = (body as { messages?: unknown }).messages;
  const systemPrompt = (body as { systemPrompt?: unknown }).systemPrompt;

  if (!Array.isArray(messages) || typeof systemPrompt !== "string") {
    return NextResponse.json({ error: "messages (array) and systemPrompt (string) are required" }, { status: 400 });
  }

  const chatMessages = sanitizeMessages(messages);
  const latestUserQuestion =
    [...chatMessages].reverse().find((m) => m.role === "user")?.content ?? "";
  const webContext = await buildWebContext(latestUserQuestion);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1800,
        temperature: 0.4,
        system: `${systemPrompt}\n\n${
          webContext
            ? `LIVE_WEB_CONTEXT (cite source URLs when using it):\n${webContext}`
            : "LIVE_WEB_CONTEXT: unavailable"
        }\n\nRUNTIME_CAPABILITIES:
- web_access: enabled via LIVE_WEB_CONTEXT for this request.
- If asked whether you can access the web, answer YES and explain you can use the live web context provided by the system.
- If LIVE_WEB_CONTEXT contains an error, say web access is temporarily unavailable for this request; do NOT claim you fundamentally lack web access.

Answer directly. Do not ask to perform another search.`,
        messages: chatMessages,
      }),
      cache: "no-store",
    });

    const payload = (await response.json()) as {
      content?: Array<Record<string, unknown>>;
      error?: { message?: string };
    };

    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error?.message ?? `Anthropic request failed (${response.status})` },
        { status: 502 },
      );
    }

    const reply = extractTextFromContent(payload.content);

    if (!reply) {
      return NextResponse.json(
        { error: "Model completed without a text response." },
        { status: 502 },
      );
    }

    return NextResponse.json({ reply });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to execute agent query";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
