"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ExternalLink, Github, GitFork, RefreshCw, Rocket, Sparkles, Star, Zap } from "lucide-react";
import type { IdeaRecord } from "@/lib/ideas-data";
import type { GHFeedState, GHFeedType, GHRepo, GHRepoWithMatch } from "@/lib/github-types";
import { findRelatedIdea, formatCount, languageColor, relativeTime } from "@/lib/github-utils";

interface GitHubFeedsWidgetProps {
  ideas: IdeaRecord[];
  onIdeaSelect: (idea: IdeaRecord) => void;
}


export function GitHubFeedsWidget({ ideas, onIdeaSelect }: GitHubFeedsWidgetProps) {
  const [activeFeed, setActiveFeed] = useState<GHFeedType>("saas");
  const [feedState, setFeedState] = useState<GHFeedState>({
    saas: [],
    ai: [],
    events: [],
    isLoading: true,
    error: null,
    cachedAt: null,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** Avoid Date.now() during SSR initial state (server vs client mismatch). */
  const [now, setNow] = useState<number | null>(null);

  const fetchFeed = useCallback(async (feed: GHFeedType, silent = false) => {
    if (!silent) {
      setFeedState((prev) => ({ ...prev, isLoading: true, error: null }));
    } else {
      setIsRefreshing(true);
    }

    try {
      const response = await fetch(`/api/github?feed=${feed}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);

      setFeedState((prev) => ({
        ...prev,
        [feed]: payload.repos as GHRepo[],
        isLoading: false,
        error: null,
        cachedAt: new Date(payload.cachedAt),
      }));
    } catch (error) {
      setFeedState((prev) => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : "Could not load GitHub data. Showing cached results.",
      }));
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([fetchFeed("saas"), fetchFeed("ai"), fetchFeed("events")]);
  }, [fetchFeed]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchFeed(activeFeed, true);
    }, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeFeed, fetchFeed]);

  useEffect(() => {
    setNow(Date.now());
    const ticker = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(ticker);
  }, []);

  const enrichedRepos = useMemo<GHRepoWithMatch[]>(() => {
    const current =
      activeFeed === "saas" ? feedState.saas
      : activeFeed === "ai" ? feedState.ai
      : feedState.events;
    return current.map((repo) => ({
      ...repo,
      relatedIdea: findRelatedIdea(`${repo.name} ${repo.description} ${repo.topics.join(" ")}`, ideas),
    }));
  }, [activeFeed, feedState.saas, feedState.ai, feedState.events, ideas]);

  const lastUpdated =
    feedState.cachedAt && now != null
      ? `${Math.max(1, Math.floor((now - feedState.cachedAt.getTime()) / 60_000))}m ago`
      : "just now";

  return (
    <div className="bg-card rounded-lg p-6 border border-border h-[520px] max-h-[520px] flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Github className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-base font-semibold text-foreground">GitHub Pulse</h3>
        </div>
        <button
          type="button"
          onClick={() => void fetchFeed(activeFeed, true)}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
          aria-label={`Refresh GitHub feed, last updated ${lastUpdated}`}
        >
          <RefreshCw className={`w-4 h-4 text-muted-foreground ${isRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="inline-flex rounded-xl bg-muted p-1">
          <button
            type="button"
            onClick={() => setActiveFeed("saas")}
            className={`px-2.5 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1 ${
              activeFeed === "saas" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Zap className="w-3 h-3" />
            SaaS
          </button>
          <button
            type="button"
            onClick={() => setActiveFeed("ai")}
            className={`px-2.5 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1 ${
              activeFeed === "ai" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Bot className="w-3 h-3" />
            AI Tools
          </button>
          <button
            type="button"
            onClick={() => setActiveFeed("events")}
            className={`px-2.5 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1 ${
              activeFeed === "events" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Rocket className="w-3 h-3" />
            Launches
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">refreshed {lastUpdated}</span>
      </div>

      {feedState.error && enrichedRepos.length > 0 ? (
        <div className="mb-2 text-xs text-warning">
          Showing cached data.{" "}
          <button type="button" onClick={() => void fetchFeed(activeFeed)} className="underline underline-offset-2">
            Try again
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto -mr-2 pr-2">
        {feedState.isLoading ? (
          <LoadingSkeleton />
        ) : feedState.error && enrichedRepos.length === 0 ? (
          <ErrorState error={feedState.error} onRetry={() => void fetchFeed(activeFeed)} />
        ) : enrichedRepos.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-0 divide-y divide-border/40">
            {enrichedRepos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} onIdeaSelect={onIdeaSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RepoCard({ repo, onIdeaSelect }: { repo: GHRepoWithMatch; onIdeaSelect: (idea: IdeaRecord) => void }) {
  const shownTopics = repo.topics.slice(0, 3);
  const overflowTopics = Math.max(0, repo.topics.length - shownTopics.length);

  return (
    <article className="py-3 hover:bg-muted/40 rounded-xl px-2 -mx-2 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-1">
        <a
          href={repo.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 inline-flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary"
        >
          {repo.ownerAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={repo.ownerAvatar} alt={repo.owner} className="w-5 h-5 rounded-full" />
          ) : null}
          <span className="truncate">{repo.fullName}</span>
          <ExternalLink className="w-3 h-3 shrink-0" />
        </a>
        {repo.license ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{repo.license}</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mb-1.5">{repo.description || "No description provided."}</p>
      {repo.insight ? (
        <div className="flex items-start gap-1 mb-2">
          <Sparkles className="w-3 h-3 mt-0.5 text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug italic">{repo.insight}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Star className="w-3 h-3" />{formatCount(repo.stars)}</span>
        <span className="inline-flex items-center gap-1"><GitFork className="w-3 h-3" />{formatCount(repo.forks)}</span>
        <span className={`inline-flex items-center gap-1 ${languageColor(repo.language)}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {repo.language ?? "Unknown"}
        </span>
        {shownTopics.map((topic) => (
          <span key={topic} className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">#{topic}</span>
        ))}
        {overflowTopics > 0 ? <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">+{overflowTopics}</span> : null}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {repo.relatedIdea ? (
          <button
            type="button"
            onClick={() => onIdeaSelect(repo.relatedIdea as IdeaRecord)}
            className="text-xs rounded-full bg-primary/10 text-primary px-2 py-1 hover:bg-primary/15"
          >
            {"->"} {repo.relatedIdea.idea}
          </button>
        ) : <span />}
        <span className="text-[11px] text-muted-foreground">pushed {relativeTime(repo.pushedAt)}</span>
      </div>
    </article>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-0 divide-y divide-border/40">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex gap-3 items-start py-3">
          <div className="w-5 h-5 rounded-full bg-muted animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted rounded w-2/3 animate-pulse" />
            <div className="h-3 bg-muted rounded w-full animate-pulse" />
            <div className="h-3 bg-muted rounded w-1/2 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
      <p className="font-medium text-foreground mb-1">Could not load GitHub data</p>
      <p className="text-muted-foreground mb-3">{error}</p>
      <button type="button" onClick={onRetry} className="text-xs underline underline-offset-2">
        Try again
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
      <p className="font-medium text-foreground mb-1">No repos found right now</p>
      <p className="text-muted-foreground">GitHub trending data can be sparse. Try refreshing in a few minutes.</p>
    </div>
  );
}
