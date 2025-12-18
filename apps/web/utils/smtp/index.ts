/**
 * SMTP Utilities Index
 */

export {
  getSmtpTransporter,
  createSmtpTransporter,
  testSmtpConnection,
  sendEmail,
  sendReply,
  sendForward,
  buildDraftMessage,
  closeAllSmtpConnections,
  parseEmailAddress,
  formatEmailAddress,
  type SendEmailOptions,
  type SendEmailResult,
} from "./client";
