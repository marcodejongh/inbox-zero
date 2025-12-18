/**
 * IMAP Search Operations
 *
 * Provides search functionality for IMAP messages.
 */

import type { ImapSimple } from "imap-simple";
import type { ImapSearchCriteria, ImapMessage } from "./types";
import { parseImapMessage } from "./message";

/**
 * Search operators for building complex queries
 */
export type SearchOperator =
  | "ALL"
  | "ANSWERED"
  | "DELETED"
  | "DRAFT"
  | "FLAGGED"
  | "NEW"
  | "OLD"
  | "RECENT"
  | "SEEN"
  | "UNANSWERED"
  | "UNDELETED"
  | "UNDRAFT"
  | "UNFLAGGED"
  | "UNSEEN";

/**
 * Advanced search options
 */
export interface AdvancedSearchOptions {
  folder?: string;
  limit?: number;
  offset?: number;
  sortBy?: "date" | "from" | "subject" | "size";
  sortOrder?: "asc" | "desc";
  fetchBody?: boolean;
}

/**
 * Search messages with criteria
 */
export async function searchMessages(
  connection: ImapSimple,
  criteria: ImapSearchCriteria,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  const {
    folder = "INBOX",
    limit = 50,
    offset = 0,
    sortOrder = "desc",
    fetchBody = true,
  } = options;

  await connection.openBox(folder);

  // Build search criteria
  const searchCriteria = buildSearchCriteria(criteria);

  // Fetch messages
  const results = await connection.search(searchCriteria, {
    bodies: fetchBody ? ["HEADER", ""] : ["HEADER"],
    struct: true,
  });

  // Sort by date (UID is not reliable for sorting by date)
  results.sort((a, b) => {
    const dateA = a.attributes.date?.getTime() || 0;
    const dateB = b.attributes.date?.getTime() || 0;
    return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
  });

  // Apply pagination
  const paginated = results.slice(offset, offset + limit);

  // Parse messages
  const messages: ImapMessage[] = [];
  for (const result of paginated) {
    try {
      const parsed = await parseImapMessage(result, folder);
      messages.push(parsed);
    } catch (error) {
      console.error(`Failed to parse message:`, error);
    }
  }

  return messages;
}

/**
 * Build IMAP search criteria array
 */
function buildSearchCriteria(criteria: ImapSearchCriteria): any[] {
  const searchCriteria: any[] = [];

  // Default to ALL if no specific criteria
  if (Object.keys(criteria).length === 0) {
    return ["ALL"];
  }

  // Date criteria
  if (criteria.since) {
    searchCriteria.push(["SINCE", formatImapDate(criteria.since)]);
  }

  if (criteria.before) {
    searchCriteria.push(["BEFORE", formatImapDate(criteria.before)]);
  }

  // Header criteria
  if (criteria.from) {
    searchCriteria.push(["FROM", criteria.from]);
  }

  if (criteria.to) {
    searchCriteria.push(["TO", criteria.to]);
  }

  if (criteria.subject) {
    searchCriteria.push(["SUBJECT", criteria.subject]);
  }

  // Body search
  if (criteria.body) {
    searchCriteria.push(["BODY", criteria.body]);
  }

  // Flag criteria
  if (criteria.seen === true) {
    searchCriteria.push("SEEN");
  } else if (criteria.seen === false || criteria.unseen) {
    searchCriteria.push("UNSEEN");
  }

  if (criteria.flagged) {
    searchCriteria.push("FLAGGED");
  }

  if (criteria.keyword) {
    searchCriteria.push(["KEYWORD", criteria.keyword]);
  }

  // UID criteria
  if (criteria.uid && criteria.uid.length > 0) {
    searchCriteria.push(["UID", criteria.uid.join(",")]);
  }

  return searchCriteria.length > 0 ? searchCriteria : ["ALL"];
}

/**
 * Format date for IMAP (DD-MMM-YYYY)
 */
function formatImapDate(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
}

/**
 * Search for messages from a specific sender
 */
export async function searchFromSender(
  connection: ImapSimple,
  senderEmail: string,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { from: senderEmail }, options);
}

/**
 * Search for messages to a specific recipient
 */
export async function searchToRecipient(
  connection: ImapSimple,
  recipientEmail: string,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { to: recipientEmail }, options);
}

/**
 * Search for messages with a subject containing text
 */
export async function searchBySubject(
  connection: ImapSimple,
  subjectText: string,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { subject: subjectText }, options);
}

/**
 * Search for unread messages
 */
export async function searchUnread(
  connection: ImapSimple,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { unseen: true }, options);
}

/**
 * Search for flagged/starred messages
 */
export async function searchFlagged(
  connection: ImapSimple,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { flagged: true }, options);
}

/**
 * Search for messages within a date range
 */
export async function searchByDateRange(
  connection: ImapSimple,
  since: Date,
  before: Date,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  return searchMessages(connection, { since, before }, options);
}

/**
 * Full-text search in body and headers
 */
export async function fullTextSearch(
  connection: ImapSimple,
  query: string,
  options: AdvancedSearchOptions = {},
): Promise<ImapMessage[]> {
  // IMAP doesn't have a single full-text search command
  // We search in subject and body separately and combine results
  const { folder = "INBOX" } = options;

  await connection.openBox(folder);

  // Search in subject
  const subjectResults = await connection.search([["SUBJECT", query]], {
    bodies: [],
  });

  // Search in body
  const bodyResults = await connection.search([["BODY", query]], {
    bodies: [],
  });

  // Combine and deduplicate by UID
  const uidSet = new Set<number>();
  const allResults: any[] = [];

  for (const result of [...subjectResults, ...bodyResults]) {
    if (!uidSet.has(result.attributes.uid)) {
      uidSet.add(result.attributes.uid);
      allResults.push(result);
    }
  }

  // Fetch full messages for combined results
  if (allResults.length === 0) {
    return [];
  }

  const uids = allResults.map((r) => r.attributes.uid);
  const fullResults = await connection.search([["UID", uids.join(",")]], {
    bodies: options.fetchBody !== false ? ["HEADER", ""] : ["HEADER"],
    struct: true,
  });

  // Parse messages
  const messages: ImapMessage[] = [];
  for (const result of fullResults) {
    try {
      const parsed = await parseImapMessage(result, folder);
      messages.push(parsed);
    } catch (error) {
      console.error(`Failed to parse message:`, error);
    }
  }

  // Sort and paginate
  messages.sort(
    (a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const { offset = 0, limit = 50 } = options;
  return messages.slice(offset, offset + limit);
}

/**
 * Count messages matching criteria
 */
export async function countMessages(
  connection: ImapSimple,
  criteria: ImapSearchCriteria,
  folder: string = "INBOX",
): Promise<number> {
  await connection.openBox(folder);

  const searchCriteria = buildSearchCriteria(criteria);
  const results = await connection.search(searchCriteria, { bodies: [] });

  return results.length;
}

/**
 * Get UIDs of messages matching criteria
 */
export async function getMatchingUids(
  connection: ImapSimple,
  criteria: ImapSearchCriteria,
  folder: string = "INBOX",
): Promise<number[]> {
  await connection.openBox(folder);

  const searchCriteria = buildSearchCriteria(criteria);
  const results = await connection.search(searchCriteria, { bodies: [] });

  return results.map((r: any) => r.attributes.uid);
}

/**
 * Build a Gmail-style query from structured criteria
 * This converts our criteria to a format similar to Gmail's search
 */
export function buildQueryString(criteria: ImapSearchCriteria): string {
  const parts: string[] = [];

  if (criteria.from) {
    parts.push(`from:${criteria.from}`);
  }

  if (criteria.to) {
    parts.push(`to:${criteria.to}`);
  }

  if (criteria.subject) {
    parts.push(`subject:${criteria.subject}`);
  }

  if (criteria.body) {
    parts.push(criteria.body);
  }

  if (criteria.since) {
    parts.push(`after:${criteria.since.toISOString().split("T")[0]}`);
  }

  if (criteria.before) {
    parts.push(`before:${criteria.before.toISOString().split("T")[0]}`);
  }

  if (criteria.unseen) {
    parts.push("is:unread");
  }

  if (criteria.flagged) {
    parts.push("is:starred");
  }

  return parts.join(" ");
}

/**
 * Parse a Gmail-style query string into search criteria
 */
export function parseQueryString(query: string): ImapSearchCriteria {
  const criteria: ImapSearchCriteria = {};

  // Extract from:
  const fromMatch = query.match(/from:(\S+)/i);
  if (fromMatch) {
    criteria.from = fromMatch[1];
  }

  // Extract to:
  const toMatch = query.match(/to:(\S+)/i);
  if (toMatch) {
    criteria.to = toMatch[1];
  }

  // Extract subject:
  const subjectMatch = query.match(/subject:(\S+)/i);
  if (subjectMatch) {
    criteria.subject = subjectMatch[1];
  }

  // Extract after:/since:
  const afterMatch = query.match(/(?:after|since):(\d{4}-\d{2}-\d{2})/i);
  if (afterMatch) {
    criteria.since = new Date(afterMatch[1]);
  }

  // Extract before:
  const beforeMatch = query.match(/before:(\d{4}-\d{2}-\d{2})/i);
  if (beforeMatch) {
    criteria.before = new Date(beforeMatch[1]);
  }

  // Extract is:unread
  if (query.match(/is:unread/i)) {
    criteria.unseen = true;
  }

  // Extract is:starred
  if (query.match(/is:starred/i)) {
    criteria.flagged = true;
  }

  // Remaining text is body search
  const remainingText = query
    .replace(/(?:from|to|subject|after|since|before):\S+/gi, "")
    .replace(/is:(?:unread|starred)/gi, "")
    .trim();

  if (remainingText) {
    criteria.body = remainingText;
  }

  return criteria;
}
