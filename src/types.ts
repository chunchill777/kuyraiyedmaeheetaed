export type SteepCategory =
  | "social"
  | "technology"
  | "economic"
  | "environmental"
  | "political"
  | "general";

export type Source = {
  name: string;
  category?: string;
  baseUrl?: string;
  homepageUrl?: string;
  feedUrl?: string;
  startUrls?: string[];
  dailySearchUrlTemplates?: string[];
  searchUrlTemplates?: string[];
  archiveUrlTemplates?: string[];
  sitemapUrls?: string[];
  /** Minimum distinct publication months required before a 365-day job completes. */
  minCoverageMonths?: number;
};

export type DiscoveredUrl = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  discoveryMethod: "sitemap" | "archive" | "startUrl";
};
