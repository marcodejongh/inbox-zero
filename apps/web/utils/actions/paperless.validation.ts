import { z } from "zod";

export const connectPaperlessBody = z.object({
  baseUrl: z.string().url(),
  apiToken: z.string().trim().min(1),
});
export const updateFilingDestinationBody = z.object({
  destination: z.enum(["cloud", "paperless"]),
});
export const savePaperlessAttachmentBody = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
});
export const resolvePaperlessFilingBody = z.object({
  filingId: z.string().min(1),
});
