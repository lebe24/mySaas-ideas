# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run dev server at http://127.0.0.1:3000
pnpm build            # production build
pnpm lint             # run ESLint

# Test scripts (no test framework — these are Node scripts)
node scripts/test-agent-tooling.mjs
node scripts/test-one-page-checkout-insights.mjs
node scripts/test-overview-data-sources.mjs
```

> `typescript.ignoreBuildErrors` is enabled in `next.config.mjs` — the build will succeed with type errors. Run `tsc --noEmit` to check types manually.

## Environment

Copy `.env.example` to `.env.local` before running. Key variables:

- `ANTHROPIC_API_KEY` — required for the `/api/chat` and `/api/ideas/validate` routes
- `GITHUB_TOKEN` — optional; enables the GitHub trending repos widget
- `PRODUCT_HUNT_TOKEN` / `PH_TOKEN` — use a developer token (simplest), or provide `PH_CLIENT_ID` + `PH_CLIENT_SECRET` for OAuth app credentials

## Architecture

### Pages

| Route | Purpose |
|---|---|
| `/` (`app/page.tsx`) | Static landing page — links to `/dashboard` |
| `/dashboard` | Main workspace (sidebar + content pane + optional right filter panel) |
| `/explore?idea=<name>` | Standalone per-idea chat with prompt-kit streaming UI |

### Dashboard layout (`/dashboard`)

State lives entirely in `DashboardPage` (`app/dashboard/page.tsx`) and is passed down as props. There is no global state manager.

- **`AppSidebar`** — navigation; emits `onSectionChange(Section)`
- **`MainContent`** — renders the active section via a `Section → component` switch; owns the chat history and relays `onAskAIAboutIdea` from idea cards to parent
- **`RightPanel`** — filter controls for `IdeaFilters`; conditionally rendered and closeable; collapses automatically on mobile and when entering the chat section

The `Section` union type (`lib/dashboard-section.ts`) is the single source of truth for valid navigation targets.

### Data flow for ideas

1. **Source**: `db/Micro-SaaS Ideas Database [Starter Story].xlsx` — the only persistent store
2. **API read**: `GET /api/ideas` parses the workbook with `xlsx`, skips header rows (rows 0–1), normalises each row into an `IdeaRecord` via `lib/ideas-data.ts`
3. **API write**: `POST /api/ideas/add` appends a new row to the same workbook file
4. **Validation gate**: Before adding, the UI calls `POST /api/ideas/validate` which sends the payload to Claude (`claude-sonnet-4-20250514`) and expects a JSON response `{ isValid, score, summary, suggestions }`

`IdeaRecord` (defined in `lib/ideas-data.ts`) extends `RawIdeaRow` with parsed numerics (`scoreNum`, `revNumK`, `costNumK`), bucketed group strings (`scoreGroup`, `revGroup`, `costGroup`), and a `tacticSet: Set<string>` used for O(1) filter matching.

Filtering and stats are computed purely client-side using `filterIdeas()` and `computeIdeaStats()` from `lib/ideas-data.ts`.

### AI chat (`/dashboard` → chat section)

`IdeaChatContent` (`components/dashboard/content/IdeaChatContent.tsx`) manages chat state locally. On each send it:

1. Fetches all ideas from `/api/ideas`
2. Builds a system prompt via `buildSystemPrompt()` (`lib/chat-utils.ts`), which serialises the full dataset as JSON and injects active filter context
3. POSTs `{ messages, systemPrompt }` to `POST /api/chat`
4. The route enriches the system prompt with a live Bing web search result for the user's question before calling Anthropic

The explore page (`/explore`) has its own standalone chat that uses the same `/api/chat` endpoint but a different (simpler) system prompt built inline.

### External data widgets (overview section)

- **GitHub widget** (`components/dashboard/overview/GitHubFeedsWidget.tsx`) — calls `GET /api/github?feed=saas|ai`; caches results in a module-level `Map` for 15 minutes; requires `GITHUB_TOKEN`
- **Product Hunt widget** — calls `GET /api/producthunt`; supports developer token (bearer) or OAuth client credentials with in-memory token caching; returns `{ enabled: false }` gracefully when unconfigured

### `components/prompt-kit/`

Reusable streaming chat primitives (`ChatContainer`, `PromptInput`, `ResponseStream`, `Markdown`, `Reasoning`). These are used directly on the `/explore` page and indirectly (via the dashboard chat components) on `/dashboard`.

### `components/ui/`

Standard shadcn/ui components. Do not edit these files directly — regenerate via `shadcn` CLI if an update is needed.

## Key conventions

- Path alias `@/` maps to the repo root (configured in `tsconfig.json`)
- All API routes are under `app/api/` and use Next.js Route Handlers (no `pages/api/`)
- Client components are marked `"use client"` at the top; everything else is a Server Component by default
- Currency values in the dataset are parsed to `number | null` in thousands (K) by `parseCurrencyToK()` — `$1.2M` → `1200`, `$500K` → `500`, `$800` → `0.8`
- The `"—"` string is the sentinel for missing/empty spreadsheet cells throughout the codebase
