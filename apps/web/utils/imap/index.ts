/**
 * IMAP Utilities Index
 *
 * Re-exports all IMAP utility functions for easy importing.
 */

// Types
export * from "./types";

// Client connection management
export {
  connectImap,
  disconnectImap,
  testImapConnection,
  openMailbox,
  closeAllConnections,
  getImapCapabilities,
} from "./client";

// Message operations
export {
  parseImapMessage,
  fetchMessages,
  fetchMessageByUid,
  fetchMessagesByMessageIds,
  fetchNewMessagesSince,
  getMessageCount,
  markAsRead,
  markAsUnread,
  addFlag,
  removeFlag,
  deleteMessage,
  moveMessage,
  copyMessage,
} from "./message";

// Thread detection
export {
  generateThreadId,
  groupMessagesIntoThreads,
  findThreadMessages,
  normalizeSubject,
  subjectsMatch,
  buildThreadTree,
  getLatestMessage,
  getThreadRoot,
  type ThreadNode,
} from "./thread";

// Folder operations
export {
  listFolders,
  findFolderBySpecialUse,
  findFolderByPath,
  findFolderByName,
  getInboxPath,
  getSentPath,
  getDraftsPath,
  getTrashPath,
  getSpamPath,
  getArchivePath,
  createFolder,
  deleteFolder,
  renameFolder,
  subscribeFolder,
  unsubscribeFolder,
  getOrCreateFolder,
  flattenFolders,
  getFolderStats,
  STANDARD_FOLDERS,
  SPECIAL_USE_FLAGS,
} from "./folder";

// Keyword/label operations
export {
  addKeyword,
  removeKeyword,
  getKeywords,
  sanitizeKeyword,
  labelToKeyword,
  keywordToLabel,
  addInboxZeroLabel,
  removeInboxZeroLabel,
  hasInboxZeroLabel,
  searchByKeyword,
  addLabelViaFolder,
  removeLabelViaFolder,
  listAllLabels,
  smartAddLabel,
  smartRemoveLabel,
  supportsKeywords,
  INBOX_ZERO_KEYWORD_PREFIX,
  INBOX_ZERO_LABELS,
  LABELS_FOLDER_PREFIX,
} from "./keyword";

// Capability detection
export {
  detectCapabilities,
  detectServerType,
  getServerInfo,
  getCachedServerInfo,
  clearServerInfoCache,
  capabilitiesToJson,
  capabilitiesFromJson,
  getOptimizedFetchOptions,
  type ImapServerType,
  type ServerInfo,
} from "./capabilities";

// Search operations
export {
  searchMessages,
  searchFromSender,
  searchToRecipient,
  searchBySubject,
  searchUnread,
  searchFlagged,
  searchByDateRange,
  fullTextSearch,
  countMessages,
  getMatchingUids,
  buildQueryString,
  parseQueryString,
  type SearchOperator,
  type AdvancedSearchOptions,
} from "./search";
