import type { IdeaRecord } from "./ideas-data";
import type { ChatContext } from "./chat-types";

// ─── Compact dataset encoder ──────────────────────────────────────────────────
// Encodes 190 ideas as a pipe-delimited table instead of JSON.
// JSON: ~6 key repetitions × 190 rows × ~3 tokens = ~3,400 wasted tokens.
// Table: keys appear once as a header → saves ~3K tokens vs JSON.

function buildDatasetTable(records: IdeaRecord[]): string {
  const header = "name | revenue/mo | start_cost | score | icp | tactics";
  const rows = records.map((r) =>
    [
      r.idea,
      r.monthlyRevenue,
      r.startingCosts,
      r.solopreneurScore,
      r.icp,
      r.growthTactics,
    ].join(" | "),
  );
  return [header, ...rows].join("\n");
}

// ─── Follow-up detection ──────────────────────────────────────────────────────
// Returns true when the message is clearly a conversational follow-up that
// doesn't require fresh web research (e.g. "show source links", "summarize",
// "list them again"). The API route uses this to skip the agentic tool loop.

const FOLLOWUP_PATTERNS = [
  /\bsource[s]?\b/i,
  /\blink[s]?\b/i,
  /\burl[s]?\b/i,
  /\bref(erence)?[s]?\b/i,
  /\bwhere did you\b/i,
  /\byou (said|mentioned|found|showed)\b/i,
  /\bfrom (above|your|the) (response|answer|search)\b/i,
  /\bsummar(ise|ize)\b/i,
  /\blist (them|those|it)\b/i,
  /\bshow (me|them)\b/i,
  /\brepeat\b/i,
  /\bcan you (re)?list\b/i,
  /\bthanks?\b/i,
  /\bthank you\b/i,
  /^(ok|okay|great|cool|got it|nice|perfect|makes sense)[\s!.]*$/i,
];

const RESEARCH_TRIGGERS = [
  /\bsearch\b/i,
  /\blook up\b/i,
  /\bfind out\b/i,
  /\bwhat (is|are|does|do)\b/i,
  /\bhow (much|many|do|does|can)\b/i,
  /\bwho (is|are|makes|built)\b/i,
  /\bcompetitor[s]?\b/i,
  /\bpric(e|ing)\b/i,
  /\bmarket (size|cap|share)\b/i,
  /\blaunch(ed)?\b/i,
  /\bnews\b/i,
  /\btrend[s]?\b/i,
  /\brecent(ly)?\b/i,
  /\blatest\b/i,
  /\bcurrent(ly)?\b/i,
  /\b20(24|25|26)\b/,
];

/**
 * Returns true when the message is a conversational follow-up that does NOT
 * need fresh web research — so the API route can use the cheap fast path.
 *
 * @param message        The latest user message
 * @param hasHistory     Whether there are prior assistant turns
 * @param lastAssistantMsg  The previous assistant response text (optional)
 */
export function isFollowUpMessage(
  message: string,
  hasHistory: boolean,
  lastAssistantMsg?: string,
): boolean {
  if (!hasHistory) return false;
  const text = message.trim();

  const needsResearch = RESEARCH_TRIGGERS.some((r) => r.test(text));

  // ── Source / link requests need special handling ──────────────────────────
  // If the user asks for "source links" but the previous response contains no
  // real URLs (https://…), Claude used general knowledge — we must search now.
  const isAskingForLinks =
    /\bsource[s]?\b|\blink[s]?\b|\burl[s]?\b|\bref(erence)?[s]?\b/i.test(text);

  if (isAskingForLinks) {
    const prevHasUrls = lastAssistantMsg ? /https?:\/\/\S+/.test(lastAssistantMsg) : false;
    // No real URLs in prior response → must do a real search, not a fast path
    if (!prevHasUrls) return false;
    // URLs exist in prior response AND no new research needed → fast path is fine
    return !needsResearch;
  }

  // Very short messages with no research keywords are always follow-ups
  if (text.length < 60 && !needsResearch) return true;

  // Explicit follow-up patterns, but only when no new research is needed
  if (FOLLOWUP_PATTERNS.some((p) => p.test(text))) {
    return !needsResearch;
  }

  return false;
}

// ─── System prompt builder ────────────────────────────────────────────────────

export function buildSystemPrompt(dataset: IdeaRecord[], context: ChatContext): string {
  const filtersActive = context.matchingIdeas.length !== context.totalIdeas;
  const filteredNames = context.matchingIdeas.map((i) => i.idea);

  return `
You are an expert startup analyst and business advisor specialising in
Micro-SaaS businesses, solopreneur ventures, and indie hacking. You have
deep knowledge of the Starter Story Micro-SaaS Ideas Database — ${dataset.length}
validated ideas with real revenue data, solopreneur scores, ICP profiles,
starting costs, and growth tactics.

<dataset>
${buildDatasetTable(dataset)}
</dataset>

<filter_context>
${
  filtersActive
    ? `Filters are active. Reason within this subset by default unless the user asks otherwise.
     Matching ideas (${context.matchingIdeas.length}): ${filteredNames.join(", ")}
     Filter state: ${JSON.stringify(context.ideaFilters)}`
    : `No filters active. All ${dataset.length} ideas are in scope.`
}
</filter_context>

${context.lastMentionedIdea ? `<last_discussed>${context.lastMentionedIdea}</last_discussed>` : ""}

Behaviour rules:
- Always cite specific idea names when making recommendations
- Format revenue as $24K/mo or $1.2M/mo; starting costs as $XK or $0
- Use markdown tables for side-by-side comparisons
- Use phased structure for go-to-market plans (Week 1-4, Month 2-3, etc.)
- Keep responses concise unless asked for detail
- When filters are active, state this explicitly: "Within your current filter..."
- Solopreneur score is out of 100 — higher = easier to build solo
- Use web_search / web_fetch for competitor research, pricing, market sizing, and current news
- Never claim you cannot access the internet — you have live web tools
`.trim();
}

export function detectMentionedIdea(text: string, dataset: IdeaRecord[]): string | null {
  const lower = text.toLowerCase();
  const matches = dataset.filter((idea) => lower.includes(idea.idea.toLowerCase()));
  return matches.length > 0 ? matches[matches.length - 1].idea : null;
}
