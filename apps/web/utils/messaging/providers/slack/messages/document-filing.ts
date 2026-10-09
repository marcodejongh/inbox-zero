import type { KnownBlock, Block } from "@slack/types";
import { getDriveFileUrl } from "@/utils/drive/url";
import type { DriveProviderType } from "@/utils/drive/types";

export type DocumentFiledBlocksParams = {
  filename: string;
  folderPath: string;
  driveProvider: string;
  senderEmail?: string | null;
  fileId?: string | null;
  webUrl?: string | null;
};

export type DocumentAskBlocksParams = {
  filename: string;
  reasoning: string | null;
  senderEmail?: string | null;
  paperless?: boolean;
};

export function buildDocumentFiledBlocks({
  filename,
  folderPath,
  driveProvider,
  senderEmail,
  fileId,
  webUrl,
}: DocumentFiledBlocksParams): (KnownBlock | Block)[] {
  const fileLink =
    webUrl ||
    (fileId && (driveProvider === "google" || driveProvider === "microsoft")
      ? getDriveFileUrl(fileId, driveProvider as DriveProviderType)
      : null);

  const fileDisplay = fileLink ? `<${fileLink}|${filename}>` : `*${filename}*`;

  const fromPart = senderEmail ? ` from *${senderEmail}*` : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📨 Filed ${fileDisplay}${fromPart} to *${folderPath}*`,
      },
    },
  ];
}

export function buildDocumentAskBlocks({
  filename,
  reasoning,
  senderEmail,
  paperless,
}: DocumentAskBlocksParams): (KnownBlock | Block)[] {
  const fromPart = senderEmail ? ` from *${senderEmail}*` : "";
  const reasonPart = reasoning ? ` — ${reasoning}` : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: paperless
          ? `📄 Save *${filename}*${fromPart} to Paperless?${reasonPart} Confirm Save or Skip in attachment filing activity.`
          : `📄 Where should I file *${filename}*${fromPart}?${reasonPart}`,
      },
    },
  ];
}
