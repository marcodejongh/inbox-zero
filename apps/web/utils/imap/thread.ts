/**
 * IMAP Thread Detection
 *
 * IMAP doesn't have native threading like Gmail, so we need to detect threads
 * based on message headers (In-Reply-To, References, Subject).
 */

import type { ImapMessage } from "./types";
import crypto from "crypto";

/**
 * Generate a thread ID from message headers
 *
 * Threading logic:
 * 1. If message has In-Reply-To, use that message's thread
 * 2. If message has References, use the first reference's thread
 * 3. Otherwise, generate a new thread ID from the message ID
 */
export function generateThreadId(
  messageId: string,
  inReplyTo: string | undefined,
  references: string[],
  subject: string,
): string {
  // If it's a reply, use the original message ID as the thread root
  if (inReplyTo) {
    return hashToThreadId(inReplyTo);
  }

  // If we have references, use the first one (original message)
  if (references.length > 0) {
    return hashToThreadId(references[0]);
  }

  // Otherwise, this is a new thread - use message ID
  return hashToThreadId(messageId);
}

/**
 * Hash a message ID to create a consistent thread ID
 */
function hashToThreadId(messageId: string): string {
  // Remove angle brackets and normalize
  const normalized = messageId.replace(/[<>]/g, "").toLowerCase().trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `thread_${hash.substring(0, 24)}`;
}

/**
 * Group messages into threads
 */
export function groupMessagesIntoThreads(
  messages: ImapMessage[],
): Map<string, ImapMessage[]> {
  const threads = new Map<string, ImapMessage[]>();
  const messageIdToThread = new Map<string, string>();

  // First pass: Collect all message IDs and their thread associations
  for (const message of messages) {
    messageIdToThread.set(message.messageId, message.threadId);
  }

  // Second pass: Merge threads that should be together
  // This handles cases where messages reference each other
  const threadMergeMap = new Map<string, string>();

  for (const message of messages) {
    let targetThreadId = message.threadId;

    // Check if any of our references belong to an existing thread
    if (message.inReplyTo) {
      const replyToThread = messageIdToThread.get(message.inReplyTo);
      if (replyToThread) {
        targetThreadId = threadMergeMap.get(replyToThread) || replyToThread;
      }
    }

    for (const ref of message.references || []) {
      const refThread = messageIdToThread.get(ref);
      if (refThread) {
        const mergedThread = threadMergeMap.get(refThread) || refThread;
        if (mergedThread !== targetThreadId) {
          // Merge threads
          threadMergeMap.set(message.threadId, mergedThread);
          targetThreadId = mergedThread;
        }
      }
    }

    // Update merge map
    threadMergeMap.set(message.threadId, targetThreadId);
  }

  // Third pass: Group messages by their final thread ID
  for (const message of messages) {
    const finalThreadId = threadMergeMap.get(message.threadId) || message.threadId;

    if (!threads.has(finalThreadId)) {
      threads.set(finalThreadId, []);
    }
    threads.get(finalThreadId)!.push(message);
  }

  // Sort messages within each thread by date
  for (const threadMessages of threads.values()) {
    threadMessages.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
  }

  return threads;
}

/**
 * Find all messages in a thread given one message
 */
export function findThreadMessages(
  message: ImapMessage,
  allMessages: ImapMessage[],
): ImapMessage[] {
  const threadMessages: ImapMessage[] = [];
  const processedIds = new Set<string>();

  // Collect all related message IDs
  const relatedIds = new Set<string>();
  relatedIds.add(message.messageId);

  if (message.inReplyTo) {
    relatedIds.add(message.inReplyTo);
  }

  for (const ref of message.references || []) {
    relatedIds.add(ref);
  }

  // BFS to find all connected messages
  const queue = [message];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (processedIds.has(current.messageId)) continue;
    processedIds.add(current.messageId);
    threadMessages.push(current);

    // Find messages that reference this one or are referenced by it
    for (const otherMessage of allMessages) {
      if (processedIds.has(otherMessage.messageId)) continue;

      // Check if other message references current
      if (otherMessage.inReplyTo === current.messageId) {
        queue.push(otherMessage);
        continue;
      }

      if (otherMessage.references?.includes(current.messageId)) {
        queue.push(otherMessage);
        continue;
      }

      // Check if current references other message
      if (current.inReplyTo === otherMessage.messageId) {
        queue.push(otherMessage);
        continue;
      }

      if (current.references?.includes(otherMessage.messageId)) {
        queue.push(otherMessage);
        continue;
      }
    }
  }

  // Sort by date
  threadMessages.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return threadMessages;
}

/**
 * Normalize subject for thread matching
 * Removes Re:, Fwd:, Fw: prefixes
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd?|fw):\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Check if two messages might be in the same thread based on subject
 * This is a fallback when proper headers aren't available
 */
export function subjectsMatch(subject1: string, subject2: string): boolean {
  const normalized1 = normalizeSubject(subject1);
  const normalized2 = normalizeSubject(subject2);

  return normalized1 === normalized2;
}

/**
 * Build a thread tree structure
 */
export interface ThreadNode {
  message: ImapMessage;
  children: ThreadNode[];
  parent?: ThreadNode;
}

export function buildThreadTree(messages: ImapMessage[]): ThreadNode[] {
  const nodeMap = new Map<string, ThreadNode>();
  const roots: ThreadNode[] = [];

  // Create nodes for all messages
  for (const message of messages) {
    nodeMap.set(message.messageId, {
      message,
      children: [],
    });
  }

  // Link parents and children
  for (const message of messages) {
    const node = nodeMap.get(message.messageId)!;

    // Find parent
    const parentId = message.inReplyTo || message.references?.[message.references.length - 1];
    const parentNode = parentId ? nodeMap.get(parentId) : undefined;

    if (parentNode) {
      node.parent = parentNode;
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by date
  function sortChildren(node: ThreadNode) {
    node.children.sort(
      (a, b) =>
        new Date(a.message.date).getTime() - new Date(b.message.date).getTime(),
    );
    for (const child of node.children) {
      sortChildren(child);
    }
  }

  for (const root of roots) {
    sortChildren(root);
  }

  // Sort roots by date
  roots.sort(
    (a, b) =>
      new Date(a.message.date).getTime() - new Date(b.message.date).getTime(),
  );

  return roots;
}

/**
 * Get the latest message in a thread
 */
export function getLatestMessage(messages: ImapMessage[]): ImapMessage | null {
  if (messages.length === 0) return null;

  return messages.reduce((latest, current) =>
    new Date(current.date) > new Date(latest.date) ? current : latest,
  );
}

/**
 * Get the first message in a thread (thread root)
 */
export function getThreadRoot(messages: ImapMessage[]): ImapMessage | null {
  if (messages.length === 0) return null;

  return messages.reduce((earliest, current) =>
    new Date(current.date) < new Date(earliest.date) ? current : earliest,
  );
}
