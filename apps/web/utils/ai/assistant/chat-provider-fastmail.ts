import { googleChatProviderConfig } from "./chat-provider-google";
import type { AssistantChatProviderConfig } from "./chat-provider-shared";

// Fastmail mailboxes are exposed as labels, so only the search guidance differs.
export const fastmailChatProviderConfig: AssistantChatProviderConfig = {
  ...googleChatProviderConfig,
  searchSyntaxPolicy: `Provider search syntax:
- Fastmail searches support only: plain keywords, from:, to:, cc:, bcc:, subject:, in:, label:, is:unread, is:read, is:starred, has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:, older_than:, and a leading - to exclude a term.
- All terms must match. OR, parentheses, and any other operator are rejected; run a separate search for each alternative.
- in: and label: need an existing mailbox name or ID.`,
  inboxTriagePolicy: `Provider inbox defaults:
- For inbox triage, default to \`is:unread\` unless the user asks to include read messages.
- For reply triage, do not rely only on unread; search reply-focused keywords one at a time.
- For retroactive cleanup sampling, keyword queries like "newsletter", "promotion", or "unsubscribe" are useful.`,
};
