import type { IdeaRecord } from "@/lib/ideas-data";

export interface GHRepo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerAvatar: string;
  description: string;
  url: string;
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  pushedAt: string;
  createdAt: string;
  license: string | null;
  openIssues: number;
  insight?: string;
}

export type GHFeedType = "saas" | "ai" | "events";

export interface GHFeedState {
  saas: GHRepo[];
  ai: GHRepo[];
  events: GHRepo[];
  isLoading: boolean;
  error: string | null;
  cachedAt: Date | null;
}

export interface GHRepoWithMatch extends GHRepo {
  relatedIdea: IdeaRecord | null;
}
