/**
 * IMAP/SMTP Email Provider
 *
 * Implements the EmailProvider interface using IMAP for reading
 * and SMTP for sending emails.
 */

import type { ImapSimple } from "imap-simple";
import type { ParsedMessage } from "@/utils/types";
import type { ThreadsQuery } from "@/app/api/threads/validation";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { InboxZeroLabel } from "@/utils/label";
import type {
  EmailProvider,
  EmailThread,
  EmailLabel,
  EmailFilter,
  EmailSignature,
} from "@/utils/email/types";
import { createScopedLogger, type Logger } from "@/utils/logger";

// IMAP utilities
import {
  connectImap,
  disconnectImap,
  fetchMessages,
  fetchMessageByUid,
  fetchNewMessagesSince,
  markAsRead,
  markAsUnread,
  deleteMessage,
  moveMessage,
  addKeyword,
  removeKeyword,
  groupMessagesIntoThreads,
  findThreadMessages,
  getLatestMessage,
  listFolders,
  flattenFolders,
  getTrashPath,
  getSpamPath,
  getArchivePath,
  getDraftsPath,
  getSentPath,
  getOrCreateFolder,
  searchMessages,
  searchFromSender,
  fullTextSearch,
  countMessages,
  getCachedServerInfo,
  smartAddLabel,
  smartRemoveLabel,
  labelToKeyword,
  INBOX_ZERO_LABELS,
  type ImapConfig,
  type ImapMessage,
  type ImapCapabilities,
  type ServerInfo,
} from "@/utils/imap";

// SMTP utilities
import {
  sendEmail,
  sendReply,
  buildDraftMessage,
  type SmtpConfig,
  type SendEmailOptions,
} from "@/utils/smtp";

/**
 * Convert ImapMessage to ParsedMessage format
 */
function imapToParsedMessage(msg: ImapMessage): ParsedMessage {
  return {
    id: msg.uid.toString(),
    threadId: msg.threadId,
    labelIds: msg.labels,
    snippet: msg.snippet,
    historyId: msg.uid.toString(),
    attachments: msg.attachments.map((att, idx) => ({
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      attachmentId: att.contentId || `att_${idx}`,
      headers: {
        "content-type": att.mimeType,
        "content-description": att.filename,
        "content-transfer-encoding": "base64",
        "content-id": att.contentId || "",
      },
    })),
    inline: [],
    headers: {
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date.toISOString(),
      "message-id": msg.messageId,
      "in-reply-to": msg.inReplyTo,
      references: msg.references?.join(" "),
    },
    textPlain: msg.textPlain,
    textHtml: msg.textHtml,
    subject: msg.subject,
    date: msg.date.toISOString(),
    internalDate: msg.date.getTime().toString(),
  };
}

/**
 * Parse email address to extract just the email part
 */
function extractEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return match ? match[1] : address.trim();
}

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;
  private connection: ImapSimple | null = null;
  private readonly imapConfig: ImapConfig;
  private readonly smtpConfig: SmtpConfig;
  private readonly userEmail: string;
  private serverInfo: ServerInfo | null = null;
  private readonly logger: Logger;

  constructor(
    imapConfig: ImapConfig,
    smtpConfig: SmtpConfig,
    userEmail: string,
    logger?: Logger,
  ) {
    this.imapConfig = imapConfig;
    this.smtpConfig = smtpConfig;
    this.userEmail = userEmail;
    this.logger = (logger || createScopedLogger("imap-provider")).with({
      provider: "imap",
      email: userEmail,
    });
  }

  toJSON() {
    return { name: this.name, type: "ImapProvider" };
  }

  /**
   * Get or create IMAP connection
   */
  private async getConnection(): Promise<ImapSimple> {
    if (!this.connection) {
      this.connection = await connectImap(this.imapConfig);
      this.serverInfo = await getCachedServerInfo(
        this.connection,
        this.imapConfig.host,
        this.imapConfig.username,
      );
    }
    return this.connection;
  }

  /**
   * Get server capabilities
   */
  private async getCapabilities(): Promise<ImapCapabilities> {
    if (!this.serverInfo) {
      const conn = await this.getConnection();
      this.serverInfo = await getCachedServerInfo(
        conn,
        this.imapConfig.host,
        this.imapConfig.username,
      );
    }
    return this.serverInfo.capabilities;
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const conn = await this.getConnection();
    const folder = folderId || "INBOX";

    const messages = await fetchMessages(conn, {}, { folder, limit: 100 });
    const threads = groupMessagesIntoThreads(messages);

    const result: EmailThread[] = [];
    for (const [threadId, threadMessages] of threads) {
      const latest = getLatestMessage(threadMessages);
      result.push({
        id: threadId,
        messages: threadMessages.map(imapToParsedMessage),
        snippet: latest?.snippet || "",
      });
    }

    return result;
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const conn = await this.getConnection();

    // Search for messages in this thread
    const allMessages = await fetchMessages(conn, {}, { folder: "INBOX", limit: 500 });
    const threadMessages = allMessages.filter((m) => m.threadId === threadId);

    if (threadMessages.length === 0) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const latest = getLatestMessage(threadMessages);
    return {
      id: threadId,
      messages: threadMessages.map(imapToParsedMessage),
      snippet: latest?.snippet || "",
    };
  }

  async getLabels(): Promise<EmailLabel[]> {
    const conn = await this.getConnection();
    const folders = await listFolders(conn);
    const flatFolders = flattenFolders(folders);

    return flatFolders.map((folder) => ({
      id: folder.path,
      name: folder.name,
      type: folder.specialUse || "user",
    }));
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels();
    return labels.find((l) => l.id === labelId) || null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels();
    return labels.find((l) => l.name.toLowerCase() === name.toLowerCase()) || null;
  }

  async getFolders(): Promise<OutlookFolder[]> {
    const conn = await this.getConnection();
    const folders = await listFolders(conn);
    const flatFolders = flattenFolders(folders);

    return flatFolders.map((folder) => ({
      id: folder.path,
      displayName: folder.name,
      parentFolderId: undefined,
      childFolderCount: folder.children?.length || 0,
      unreadItemCount: 0,
      totalItemCount: 0,
    }));
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const conn = await this.getConnection();
    const uid = parseInt(messageId, 10);

    const message = await fetchMessageByUid(conn, uid);
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    return imapToParsedMessage(message);
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const conn = await this.getConnection();

    const results = await searchMessages(
      conn,
      {},
      { folder: "INBOX", limit: 1 },
    );

    // Filter by message ID header
    const found = results.find((m) => m.messageId === rfc822MessageId);
    return found ? imapToParsedMessage(found) : null;
  }

  async getSentMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const conn = await this.getConnection();
    const sentPath = await getSentPath(conn);

    if (!sentPath) {
      return [];
    }

    const messages = await fetchMessages(conn, {}, { folder: sentPath, limit: maxResults });
    return messages.map(imapToParsedMessage);
  }

  async getInboxMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const conn = await this.getConnection();
    const messages = await fetchMessages(conn, {}, { folder: "INBOX", limit: maxResults });
    return messages.map(imapToParsedMessage);
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
  }): Promise<{ id: string; threadId: string }[]> {
    const conn = await this.getConnection();
    const sentPath = await getSentPath(conn);

    if (!sentPath) {
      return [];
    }

    const messages = await fetchMessages(
      conn,
      { since: options.after, before: options.before },
      { folder: sentPath, limit: options.maxResults, fetchBody: false },
    );

    return messages.map((m) => ({ id: m.uid.toString(), threadId: m.threadId }));
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const conn = await this.getConnection();
    const sentPath = await getSentPath(conn);

    if (!sentPath) {
      return [];
    }

    const messages = await fetchMessages(
      conn,
      {},
      { folder: sentPath, limit: options.maxResults || 100 },
    );

    // Filter out excluded emails
    const filtered = messages.filter((m) => {
      const toEmail = extractEmail(m.to);
      const fromEmail = extractEmail(m.from);

      if (options.excludeToEmails?.includes(toEmail)) return false;
      if (options.excludeFromEmails?.includes(fromEmail)) return false;
      return true;
    });

    const threads = groupMessagesIntoThreads(filtered);
    const result: EmailThread[] = [];

    for (const [threadId, threadMessages] of threads) {
      const latest = getLatestMessage(threadMessages);
      result.push({
        id: threadId,
        messages: [],
        snippet: latest?.snippet || "",
      });
    }

    return result;
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const conn = await this.getConnection();
    const draftsPath = await getDraftsPath(conn);

    if (!draftsPath) {
      return [];
    }

    const messages = await fetchMessages(
      conn,
      {},
      { folder: draftsPath, limit: options?.maxResults || 20 },
    );
    return messages.map(imapToParsedMessage);
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    const thread = await this.getThread(threadId);
    return thread.messages;
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    return this.getThreadMessages(threadId);
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = [];
    for (const id of messageIds) {
      try {
        const msg = await this.getMessage(id);
        messages.push(msg);
      } catch {
        // Message might not exist
      }
    }
    return messages;
  }

  async archiveThread(threadId: string, _ownerEmail: string): Promise<void> {
    const conn = await this.getConnection();
    const archivePath = await getArchivePath(conn);

    const thread = await this.getThread(threadId);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      if (archivePath) {
        await moveMessage(conn, uid, "INBOX", archivePath);
      } else {
        // If no archive folder, remove from INBOX (some servers)
        // by adding a "processed" flag
        const caps = await this.getCapabilities();
        await smartAddLabel(conn, uid, "Archived", caps, "INBOX", msg.headers["message-id"]);
      }
    }
  }

  async archiveThreadWithLabel(
    threadId: string,
    ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    if (labelId) {
      const thread = await this.getThread(threadId);
      for (const msg of thread.messages) {
        await this.labelMessage({ messageId: msg.id, labelId, labelName: null });
      }
    }
    await this.archiveThread(threadId, ownerEmail);
  }

  async archiveMessage(messageId: string): Promise<void> {
    const conn = await this.getConnection();
    const archivePath = await getArchivePath(conn);
    const uid = parseInt(messageId, 10);

    if (archivePath) {
      await moveMessage(conn, uid, "INBOX", archivePath);
    }
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const conn = await this.getConnection();
    const archivePath = await getArchivePath(conn);

    for (const fromEmail of fromEmails) {
      const messages = await searchFromSender(conn, fromEmail, {
        folder: "INBOX",
        limit: 100,
      });

      for (const msg of messages) {
        if (archivePath) {
          await moveMessage(conn, msg.uid, "INBOX", archivePath);
        }
      }
    }
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const conn = await this.getConnection();
    const trashPath = await getTrashPath(conn);

    for (const fromEmail of fromEmails) {
      const messages = await searchFromSender(conn, fromEmail, {
        folder: "INBOX",
        limit: 100,
      });

      for (const msg of messages) {
        await deleteMessage(conn, msg.uid, "INBOX", trashPath || undefined);
      }
    }
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    const conn = await this.getConnection();
    const trashPath = await getTrashPath(conn);
    const thread = await this.getThread(threadId);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      await deleteMessage(conn, uid, "INBOX", trashPath || undefined);
    }
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const conn = await this.getConnection();
    const caps = await this.getCapabilities();
    const uid = parseInt(options.messageId, 10);
    const labelName = options.labelName || options.labelId;

    await smartAddLabel(conn, uid, labelName, caps, "INBOX");

    return { actualLabelId: options.labelId };
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    const conn = await this.getConnection();
    const caps = await this.getCapabilities();
    const thread = await this.getThread(threadId);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      await smartRemoveLabel(conn, uid, labelId, caps, "INBOX", msg.headers["message-id"]);
    }
  }

  async removeThreadLabels(threadId: string, labelIds: string[]): Promise<void> {
    for (const labelId of labelIds) {
      await this.removeThreadLabel(threadId, labelId);
    }
  }

  async draftEmail(
    email: ParsedMessage,
    args: { to?: string; subject?: string; content: string },
    userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    const conn = await this.getConnection();
    const draftsPath = await getDraftsPath(conn);

    if (!draftsPath) {
      throw new Error("Drafts folder not found");
    }

    // Build the draft message
    const draftContent = buildDraftMessage({
      from: userEmail,
      to: args.to || email.headers.from,
      subject: args.subject || `Re: ${email.subject}`,
      text: args.content,
      inReplyTo: email.headers["message-id"],
      references: email.headers.references,
    });

    // Append to drafts folder
    await (conn.imap as any).append(draftContent, {
      mailbox: draftsPath,
      flags: ["\\Draft"],
    });

    return { draftId: `draft_${Date.now()}` };
  }

  async replyToEmail(email: ParsedMessage, content: string): Promise<void> {
    await sendReply(this.smtpConfig, {
      from: this.userEmail,
      to: email.headers.from,
      subject: email.subject,
      text: content,
      inReplyTo: email.headers["message-id"] || "",
      references: email.headers.references,
    });
  }

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
  }): Promise<void> {
    await sendEmail(this.smtpConfig, {
      from: this.userEmail,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
    });
  }

  async sendEmailWithHtml(body: {
    replyToEmail?: {
      threadId: string;
      headerMessageId: string;
      references?: string;
    };
    to: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    subject: string;
    messageHtml: string;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  }): Promise<{ messageId: string; threadId: string }> {
    const options: SendEmailOptions = {
      from: this.userEmail,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      attachments: body.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType,
        encoding: "base64",
      })),
    };

    if (body.replyToEmail) {
      options.inReplyTo = body.replyToEmail.headerMessageId;
      options.references = body.replyToEmail.references;
    }

    const result = await sendEmail(this.smtpConfig, options);

    return {
      messageId: result.messageId,
      threadId: body.replyToEmail?.threadId || `thread_${Date.now()}`,
    };
  }

  async forwardEmail(
    email: ParsedMessage,
    args: { to: string; cc?: string; bcc?: string; content?: string },
  ): Promise<void> {
    const { sendForward } = await import("@/utils/smtp");

    await sendForward(this.smtpConfig, {
      from: this.userEmail,
      to: args.to,
      cc: args.cc,
      originalSubject: email.subject,
      originalFrom: email.headers.from,
      originalDate: new Date(email.date),
      originalContent: email.textPlain || email.textHtml || "",
      additionalContent: args.content,
    });
  }

  async markSpam(threadId: string): Promise<void> {
    const conn = await this.getConnection();
    const spamPath = await getSpamPath(conn);
    const thread = await this.getThread(threadId);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      if (spamPath) {
        await moveMessage(conn, uid, "INBOX", spamPath);
      }
    }
  }

  async markRead(threadId: string): Promise<void> {
    await this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    const conn = await this.getConnection();
    const thread = await this.getThread(threadId);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      if (read) {
        await markAsRead(conn, uid);
      } else {
        await markAsUnread(conn, uid);
      }
    }
  }

  async getDraft(draftId: string): Promise<ParsedMessage | null> {
    const drafts = await this.getDrafts();
    return drafts.find((d) => d.id === draftId) || null;
  }

  async deleteDraft(draftId: string): Promise<void> {
    const conn = await this.getConnection();
    const draftsPath = await getDraftsPath(conn);
    const uid = parseInt(draftId, 10);

    if (draftsPath) {
      await deleteMessage(conn, uid, draftsPath);
    }
  }

  async createLabel(name: string, _description?: string): Promise<EmailLabel> {
    const conn = await this.getConnection();
    const folder = await getOrCreateFolder(conn, name);

    return {
      id: folder.path,
      name: folder.name,
      type: "user",
    };
  }

  async deleteLabel(labelId: string): Promise<void> {
    const conn = await this.getConnection();
    const { deleteFolder } = await import("@/utils/imap/folder");
    await deleteFolder(conn, labelId);
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    // Map InboxZeroLabel to IMAP keyword
    const labelName = `InboxZero_${key}`;
    return this.createLabel(labelName);
  }

  async blockUnsubscribedEmail(_messageId: string): Promise<void> {
    // IMAP doesn't have native filter creation
    // This would need to be handled at the application level
    this.logger.warn("blockUnsubscribedEmail not supported for IMAP");
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;

    try {
      return await this.getMessage(originalMessageId);
    } catch {
      return null;
    }
  }

  async getFiltersList(): Promise<EmailFilter[]> {
    // IMAP doesn't have filters in the Gmail sense
    return [];
  }

  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    // IMAP doesn't support server-side filters
    this.logger.warn("createFilter not supported for IMAP");
    return { status: 501 };
  }

  async deleteFilter(_id: string): Promise<{ status: number }> {
    return { status: 501 };
  }

  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    return { status: 501 };
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{
    messages: ParsedMessage[];
    nextPageToken?: string;
  }> {
    const conn = await this.getConnection();
    const offset = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 50;

    let messages: ImapMessage[];

    if (options.query) {
      messages = await fullTextSearch(conn, options.query, {
        folder: "INBOX",
        limit,
        offset,
      });
    } else {
      messages = await fetchMessages(
        conn,
        { since: options.after, before: options.before },
        { folder: "INBOX", limit, offset },
      );
    }

    const hasMore = messages.length === limit;

    return {
      messages: messages.map(imapToParsedMessage),
      nextPageToken: hasMore ? (offset + limit).toString() : undefined,
    };
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{
    messages: ParsedMessage[];
    nextPageToken?: string;
  }> {
    const conn = await this.getConnection();
    const offset = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 50;

    const messages = await searchFromSender(conn, options.senderEmail, {
      folder: "INBOX",
      limit,
      offset,
    });

    const hasMore = messages.length === limit;

    return {
      messages: messages.map(imapToParsedMessage),
      nextPageToken: hasMore ? (offset + limit).toString() : undefined,
    };
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    const conn = await this.getConnection();

    // Search for messages from or to the participant
    const fromMessages = await searchFromSender(conn, options.participantEmail, {
      folder: "INBOX",
      limit: options.maxThreads || 50,
    });

    const toMessages = await searchMessages(
      conn,
      { to: options.participantEmail },
      { folder: "INBOX", limit: options.maxThreads || 50 },
    );

    // Combine and dedupe by thread ID
    const allMessages = [...fromMessages, ...toMessages];
    const threads = groupMessagesIntoThreads(allMessages);

    const result: EmailThread[] = [];
    for (const [threadId, threadMessages] of threads) {
      if (result.length >= (options.maxThreads || 50)) break;

      const latest = getLatestMessage(threadMessages);
      result.push({
        id: threadId,
        messages: threadMessages.map(imapToParsedMessage),
        snippet: latest?.snippet || "",
      });
    }

    return result;
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = [];
    for (const id of messageIds) {
      try {
        const msg = await this.getMessage(id);
        messages.push(msg);
      } catch {
        // Skip missing messages
      }
    }
    return messages;
  }

  getAccessToken(): string {
    // IMAP doesn't use OAuth tokens
    return "";
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    const conn = await this.getConnection();
    const sentPath = await getSentPath(conn);

    if (!sentPath) {
      return false;
    }

    const count = await countMessages(conn, { to: senderEmail }, sentPath);
    return count > 0;
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const conn = await this.getConnection();
    const count = await countMessages(conn, { from: senderEmail }, "INBOX");
    return Math.min(count, threshold);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const conn = await this.getConnection();
    const uid = parseInt(messageId, 10);

    const message = await fetchMessageByUid(conn, uid);
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    const attachment = message.attachments.find(
      (att, idx) => att.contentId === attachmentId || `att_${idx}` === attachmentId,
    );

    if (!attachment || !attachment.content) {
      throw new Error(`Attachment ${attachmentId} not found`);
    }

    return {
      data: attachment.content.toString("base64"),
      size: attachment.size,
    };
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{
    threads: EmailThread[];
    nextPageToken?: string;
  }> {
    const conn = await this.getConnection();
    const offset = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 50;

    let folder = "INBOX";

    // Map query type to folder
    if (options.query?.type === "sent") {
      const sentPath = await getSentPath(conn);
      if (sentPath) folder = sentPath;
    } else if (options.query?.type === "draft") {
      const draftsPath = await getDraftsPath(conn);
      if (draftsPath) folder = draftsPath;
    } else if (options.query?.type === "archive") {
      const archivePath = await getArchivePath(conn);
      if (archivePath) folder = archivePath;
    }

    const messages = await fetchMessages(conn, {}, { folder, limit, offset });
    const threads = groupMessagesIntoThreads(messages);

    const result: EmailThread[] = [];
    for (const [threadId, threadMessages] of threads) {
      const latest = getLatestMessage(threadMessages);
      result.push({
        id: threadId,
        messages: threadMessages.map(imapToParsedMessage),
        snippet: latest?.snippet || "",
      });
    }

    const hasMore = messages.length === limit;

    return {
      threads: result,
      nextPageToken: hasMore ? (offset + limit).toString() : undefined,
    };
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const conn = await this.getConnection();

    // Check for previous emails from this sender
    const count = await countMessages(
      conn,
      { from: options.from, before: options.date },
      "INBOX",
    );

    if (count > 0) return true;

    // Check sent folder for emails to this sender
    const sentPath = await getSentPath(conn);
    if (sentPath) {
      const sentCount = await countMessages(
        conn,
        { to: options.from, before: options.date },
        sentPath,
      );
      if (sentCount > 0) return true;
    }

    return false;
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const conn = await this.getConnection();

    const messages = await searchFromSender(conn, sender, {
      folder: "INBOX",
      limit,
    });

    const threads = groupMessagesIntoThreads(messages);
    const result: Array<{ id: string; snippet: string; subject: string }> = [];

    for (const [threadId, threadMessages] of threads) {
      if (result.length >= limit) break;

      const latest = getLatestMessage(threadMessages);
      if (latest) {
        result.push({
          id: threadId,
          snippet: latest.snippet,
          subject: latest.subject,
        });
      }
    }

    return result;
  }

  async processHistory(_options: {
    emailAddress: string;
    historyId?: number;
    startHistoryId?: number;
    subscriptionId?: string;
    resourceData?: {
      id: string;
      conversationId?: string;
    };
    logger?: Logger;
  }): Promise<void> {
    // IMAP doesn't have push notifications like Gmail
    // This is handled via polling instead
    this.logger.info("processHistory called - IMAP uses polling instead");
  }

  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    // IMAP doesn't support push notifications in the same way
    // Return null to indicate polling should be used instead
    return null;
  }

  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    // No-op for IMAP
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return !!(message.headers["in-reply-to"] || message.headers.references);
  }

  isSentMessage(message: ParsedMessage): boolean {
    const fromEmail = extractEmail(message.headers.from);
    return fromEmail.toLowerCase() === this.userEmail.toLowerCase();
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const conn = await this.getConnection();
    const thread = await this.getThread(threadId);

    // Ensure target folder exists
    await getOrCreateFolder(conn, folderName);

    for (const msg of thread.messages) {
      const uid = parseInt(msg.id, 10);
      await moveMessage(conn, uid, "INBOX", folderName);
    }
  }

  async getOrCreateOutlookFolderIdByName(folderName: string): Promise<string> {
    const conn = await this.getConnection();
    const folder = await getOrCreateFolder(conn, folderName);
    return folder.path;
  }

  async getSignatures(): Promise<EmailSignature[]> {
    // IMAP doesn't have built-in signature management
    // Return empty array - signatures are managed in the app
    return [];
  }

  /**
   * Clean up connections
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await disconnectImap(this.imapConfig);
      this.connection = null;
    }
  }
}
