/** What kind of work a session is: the tag shown on every session and matched by searches. */
export const CATEGORIES = ["dev", "review", "alert", "misc"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Normal development work: a ticket or a feature, up to its PR. */
export const DEFAULT_CATEGORY: Category = "misc";

const ALIASES: Record<string, Category> = { implementation: "dev", impl: "dev", development: "dev", reviews: "review", alerts: "alert", other: "misc" };

/** A category from what someone typed or an environment variable; null for anything else, including empty. */
export function parseCategory(text: string | null | undefined): Category | null {
  const word = (text ?? "").trim().toLowerCase();
  if (!word) return null;
  return (CATEGORIES as readonly string[]).includes(word) ? (word as Category) : (ALIASES[word] ?? null);
}

/**
 * A Datadog monitor link, the way alert notifications link it: `/monitors/<id>` or `/monitors#<id>` on a Datadog
 * site. The host must end in a Datadog domain, so lookalikes (`evildatadoghq.com`, `datadoghq.com.evil.com`) miss.
 */
export const DATADOG_MONITOR = /https:\/\/(?:[\w-]+\.)*(?:datadoghq\.(?:com|eu)|ddog-gov\.com)\/monitors(?:\/|#)(\d+)[^\s<>|)"']*/;

/**
 * The category a session's first prompt gives away, for sessions nobody tagged when starting them: a PR review or
 * review queue, a ticket start, or a Datadog monitor link. Null when the prompt says nothing either way.
 */
export function categoryFromPrompt(prompt: string | null | undefined): Category | null {
  const first = (prompt ?? "").trim().split("\n", 1)[0];
  if (/^\/(?:review-pr|review-queue)\b/.test(first)) return "review";
  if (/^\/carriot:new\s+[A-Za-z][A-Za-z0-9]*-\d+\b/.test(first)) return "dev";
  if (DATADOG_MONITOR.test(first)) return "alert";
  return null;
}

/** `items` split by category, in CATEGORIES order with the empty ones left out; each group keeps the order it had. */
export function groupByCategory<T>(items: T[], of: (item: T) => Category): [Category, T[]][] {
  return CATEGORIES.map((c): [Category, T[]] => [c, items.filter((item) => of(item) === c)]).filter(([, group]) => group.length > 0);
}

/** The next kind filter in the cycle: everything (null), then each category, then everything again. */
export function nextFilter(current: Category | null): Category | null {
  if (!current) return CATEGORIES[0];
  return CATEGORIES[CATEGORIES.indexOf(current) + 1] ?? null;
}

/** The next category in the cycle, for a key that retags a session without asking which. */
export function nextCategory(c: Category): Category {
  return CATEGORIES[(CATEGORIES.indexOf(c) + 1) % CATEGORIES.length];
}
