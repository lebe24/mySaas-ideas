import { NextRequest, NextResponse } from "next/server";
import type { GHRepo, GHFeedType } from "@/lib/github-types";

const GH_BASE = "https://api.github.com";
const CACHE_TTL_MS = 15 * 60 * 1000;

// Raw GitHub search results cache (query string → repos)
const searchCache = new Map<string, { data: GHRepo[]; fetchedAt: number }>();
// Enriched feed cache (feed type → repos with AI insights)
const feedCache = new Map<string, { data: GHRepo[]; fetchedAt: number }>();

function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || undefined;
}

function anthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}

function daysAgo(n: number): string {
  const date = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return date.toISOString().split("T")[0];
}

function ghHeaders() {
  const token = githubToken();
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function normalizeRepo(raw: {
  id: number;
  name: string;
  full_name: string;
  owner?: { login?: string; avatar_url?: string };
  description?: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language?: string | null;
  topics?: string[];
  pushed_at: string;
  created_at: string;
  license?: { spdx_id?: string | null } | null;
  open_issues_count: number;
}): GHRepo {
  return {
    id: raw.id,
    name: raw.name,
    fullName: raw.full_name,
    owner: raw.owner?.login ?? "unknown",
    ownerAvatar: raw.owner?.avatar_url ?? "",
    description: raw.description ?? "",
    url: raw.html_url,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    language: raw.language ?? null,
    topics: raw.topics ?? [],
    pushedAt: raw.pushed_at,
    createdAt: raw.created_at,
    license: raw.license?.spdx_id ?? null,
    openIssues: raw.open_issues_count,
  };
}

function dedupeByFullName(repos: GHRepo[]): GHRepo[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    if (seen.has(repo.fullName)) return false;
    seen.add(repo.fullName);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Rotating query pools — 6 angles per feed, cycles every 15-min cache window
// so each refresh window surfaces a different pair of queries.
// ---------------------------------------------------------------------------

function buildSaasPool(since7: string, since14: string): string[] {
  return [
    `q=topic:saas+pushed:>${since7}&sort=stars&order=desc`,
    `q=topic:micro-saas+stars:>5+pushed:>${since14}&sort=updated&order=desc`,
    `q=topic:saas+topic:nextjs+stars:>10+pushed:>${since7}&sort=updated`,
    `q=topic:subscription+topic:stripe+stars:>20+pushed:>${since14}&sort=stars`,
    `q=topic:indie-hacker+stars:>10+pushed:>${since14}&sort=updated`,
    `q=saas+boilerplate+stars:>15+pushed:>${since14}&sort=stars`,
  ];
}

function buildAiPool(since7: string, since14: string): string[] {
  return [
    `q=topic:ai-agent+stars:>100+pushed:>${since14}&sort=stars&order=desc`,
    `q=topic:automation+stars:>50+pushed:>${since7}&sort=updated&order=desc`,
    `q=topic:llm+topic:api+pushed:>${since7}&sort=updated`,
    `q=topic:openai+stars:>50+pushed:>${since7}&sort=stars`,
    `q=topic:langchain+pushed:>${since14}&sort=updated`,
    `q=topic:n8n+stars:>30+pushed:>${since14}&sort=stars`,
  ];
}

function buildEventsPool(since3: string, since7: string): string[] {
  return [
    `q=topic:saas+created:>${since7}&sort=stars&order=desc`,
    `q=topic:ai-agent+created:>${since7}&sort=stars&order=desc`,
    `q=topic:micro-saas+created:>${since3}&sort=stars`,
    `q=topic:automation+created:>${since7}&sort=stars`,
    `q=saas+launched+created:>${since7}&sort=stars`,
    `q=topic:indie+stars:>5+created:>${since3}&sort=stars`,
  ];
}

/** Pick a rotating pair from the pool based on the current 15-min bucket. */
function rotatePair(pool: string[]): [string, string] {
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS);
  const i = bucket % pool.length;
  return [pool[i], pool[(i + 1) % pool.length]];
}

// ---------------------------------------------------------------------------
// GitHub search helper (with per-query cache)
// ---------------------------------------------------------------------------

async function searchRepos(query: string): Promise<GHRepo[]> {
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const url = `${GH_BASE}/search/repositories?${query}&per_page=10`;
  const response = await fetch(url, { headers: ghHeaders(), cache: "no-store" });

  if (!response.ok) {
    if (cached) return cached.data;
    let detail = "";
    try {
      const payload = (await response.json()) as { message?: string };
      detail = payload.message ? ` - ${payload.message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`GitHub API error: ${response.status}${detail}`);
  }

  const payload = (await response.json()) as { items?: Array<Parameters<typeof normalizeRepo>[0]> };
  const items = (payload.items ?? []).map(normalizeRepo);
  searchCache.set(query, { data: items, fetchedAt: Date.now() });
  return items;
}

// ---------------------------------------------------------------------------
// Claude Haiku — generate a 10-word SaaS opportunity insight per repo
// ---------------------------------------------------------------------------

async function generateInsights(repos: GHRepo[]): Promise<Map<number, string>> {
  const apiKey = anthropicKey();
  if (!apiKey || repos.length === 0) return new Map();

  const summaries = repos.map((r) => ({
    id: r.id,
    name: r.fullName,
    desc: (r.description || "").slice(0, 120),
    topics: r.topics.slice(0, 4),
  }));

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `For each GitHub repo, write a SaaS opportunity insight in 10-12 words — why a solo founder would care. Be specific and actionable, not generic.

Repos: ${JSON.stringify(summaries)}

Respond ONLY with valid JSON (no markdown, no code block): {"insights": [{"id": <number>, "text": "<insight>"}]}`,
          },
        ],
      }),
      cache: "no-store",
    });

    if (!response.ok) return new Map();

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const raw = payload.content?.find((b) => b.type === "text")?.text ?? "";

    // Extract JSON — handles any markdown fences Claude might wrap around it
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return new Map();

    const parsed = JSON.parse(jsonMatch[0]) as {
      insights?: Array<{ id: number; text: string }>;
    };

    const map = new Map<number, string>();
    for (const item of parsed.insights ?? []) {
      if (typeof item.id === "number" && typeof item.text === "string") {
        map.set(item.id, item.text);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!githubToken()) {
    return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 503 });
  }

  const feed = (req.nextUrl.searchParams.get("feed") ?? "saas") as GHFeedType;

  // Check enriched feed cache (repos already have insights baked in)
  const cached = feedCache.get(feed);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      repos: cached.data,
      cachedAt: new Date(cached.fetchedAt).toISOString(),
      feed,
    });
  }

  const since3 = daysAgo(3);
  const since7 = daysAgo(7);
  const since14 = daysAgo(14);

  try {
    let repos: GHRepo[] = [];

    if (feed === "saas") {
      const [q1, q2] = rotatePair(buildSaasPool(since7, since14));
      const [primary, secondary] = await Promise.all([searchRepos(q1), searchRepos(q2)]);
      repos = dedupeByFullName([...primary, ...secondary]).slice(0, 8);
    } else if (feed === "ai") {
      const [q1, q2] = rotatePair(buildAiPool(since7, since14));
      const [primary, secondary] = await Promise.all([searchRepos(q1), searchRepos(q2)]);
      repos = dedupeByFullName([...primary, ...secondary]).slice(0, 8);
    } else if (feed === "events") {
      const [q1, q2] = rotatePair(buildEventsPool(since3, since7));
      const [primary, secondary] = await Promise.all([searchRepos(q1), searchRepos(q2)]);
      repos = dedupeByFullName([...primary, ...secondary]).slice(0, 8);
    } else {
      return NextResponse.json({ error: "Unknown feed type" }, { status: 400 });
    }

    // Enrich with Claude Haiku insights (graceful — never blocks the response)
    const insights = await generateInsights(repos);
    const enrichedRepos: GHRepo[] = repos.map((r) => ({
      ...r,
      ...(insights.has(r.id) ? { insight: insights.get(r.id) } : {}),
    }));

    const now = Date.now();
    feedCache.set(feed, { data: enrichedRepos, fetchedAt: now });

    return NextResponse.json({
      repos: enrichedRepos,
      cachedAt: new Date(now).toISOString(),
      feed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch GitHub data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
