"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { FileArchiveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useDriveConnections } from "@/hooks/useDriveConnections";
import { savePaperlessAttachmentAction } from "@/utils/actions/paperless";
import { isPaperlessAttachment } from "@/utils/paperless/attachments";
import { getActionErrorMessage } from "@/utils/error";
import { toastError, toastSuccess } from "@/components/Toast";

export function SaveToPaperless({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: { attachmentId: string; filename: string; mimeType: string };
}) {
  const { emailAccountId } = useAccount();
  const { data: account } = useEmailAccountFull();
  const { data } = useDriveConnections();
  const [saved, setSaved] = useState(false);
  const { execute, isExecuting } = useAction(
    savePaperlessAttachmentAction.bind(null, emailAccountId),
    {
      onSuccess: ({ data: filing }) => {
        setSaved(true);
        toastSuccess({
          description:
            filing?.status === "FILED"
              ? "Already saved to Paperless."
              : "Sent to Paperless. Track processing in attachment filing activity.",
        });
      },
      onError: ({ error }) =>
        toastError({
          description:
            getActionErrorMessage(error) || "Could not save attachment.",
        }),
    },
  );
  if (
    account?.filingDestination !== "paperless" ||
    !data?.connections.some(
      (connection) =>
        connection.provider === "paperless" && connection.isConnected,
    ) ||
    !isPaperlessAttachment(attachment)
  )
    return null;
  return (
    <Button
      variant="outline"
      size="iconSm"
      className="relative"
      type="button"
      aria-label={`Save ${attachment.filename} to Paperless`}
      title={saved ? "Sent to Paperless" : "Save to Paperless"}
      disabled={isExecuting || saved}
      loading={isExecuting}
      onClick={() =>
        execute({ messageId, attachmentId: attachment.attachmentId })
      }
    >
      <FileArchiveIcon className="size-4" />
    </Button>
  );
}
