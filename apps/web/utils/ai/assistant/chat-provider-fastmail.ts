import { createOrGetLabelTool, listLabelsTool } from "./chat-label-tools";
import { googleChatProviderConfig } from "./chat-provider-google";
import type { AssistantChatProviderConfig } from "./chat-provider-shared";

export const fastmailChatProviderConfig: AssistantChatProviderConfig = {
  taxonomy: googleChatProviderConfig.taxonomy,
  searchSyntaxPolicy: `Provider search syntax:
- Use Fastmail search syntax: from:, to:, subject:, in:inbox, is:unread, has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD, label:, newer_than:, and older_than:. Join alternatives with OR and group them with parentheses.`,
  inboxTriagePolicy: `Provider inbox defaults:
- For inbox triage, default to \`is:unread\` unless the user asks to include read messages.
- For reply triage, do not rely only on unread; include reply-needed signals like \`label:"To Reply"\` when helpful.
- For retroactive cleanup sampling, keyword queries like "newsletter", "promotion", or "unsubscribe" are useful.`,
  getTaxonomyTools: (options) => ({
    listLabels: listLabelsTool(options),
    createOrGetLabel: createOrGetLabelTool(options),
  }),
};
