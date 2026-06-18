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
};

export type DiscoveredUrl = {
  url: string;
  sourceName: string;
  sourceCategory: string | null;
  discoveryMethod: "sitemap" | "archive" | "startUrl";
};