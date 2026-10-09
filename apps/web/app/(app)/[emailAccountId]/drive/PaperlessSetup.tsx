"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useAction } from "next-safe-action/hooks";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  updateFilingPromptBody,
  type UpdateFilingPromptBody,
} from "@/utils/actions/drive.validation";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useFilingActivity } from "@/hooks/useFilingActivity";
import { useDriveConnections } from "@/hooks/useDriveConnections";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import {
  fileAttachmentAction,
  updateFilingEnabledAction,
  updateFilingPromptAction,
} from "@/utils/actions/drive";
import { fetchWithAccount } from "@/utils/fetch";
import type { GetAttachmentsPreviewResponse } from "@/app/api/user/drive/preview/attachments/route";
import { FilingActivity } from "./FilingActivity";
import { DriveConnections } from "./DriveConnections";

export function PaperlessSetup() {
  const { emailAccountId } = useAccount();
  const { data, mutate } = useEmailAccountFull();
  const { data: connections } = useDriveConnections();
  const connected = connections?.connections.some(
    (connection) =>
      connection.provider === "paperless" && connection.isConnected,
  );
  const { mutate: refreshFilings } = useFilingActivity({
    limit: 10,
    offset: 0,
  });
  const [previewing, setPreviewing] = useState(false);
  const form = useForm<UpdateFilingPromptBody>({
    resolver: zodResolver(updateFilingPromptBody),
    defaultValues: { filingPrompt: data?.filingPrompt || "" },
  });
  const save = useAction(updateFilingPromptAction.bind(null, emailAccountId), {
    onSuccess: () => {
      mutate();
      toastSuccess({ description: "Filing preferences saved." });
    },
    onError: ({ error }) =>
      toastError({
        description:
          getActionErrorMessage(error) || "Could not save preferences.",
      }),
  });
  const enable = useAction(
    updateFilingEnabledAction.bind(null, emailAccountId),
    {
      onSuccess: () => mutate(),
      onError: ({ error }) =>
        toastError({
          description:
            getActionErrorMessage(error) || "Could not enable filing.",
        }),
    },
  );
  const preview = async () => {
    setPreviewing(true);
    try {
      const response = await fetchWithAccount({
        emailAccountId,
        url: "/api/user/drive/preview/attachments",
      });
      if (!response.ok) throw new Error("Could not load recent attachments.");
      const result: GetAttachmentsPreviewResponse = await response.json();
      if (!result.attachments.length) {
        toastSuccess({ description: "No recent attachments found." });
        return;
      }
      for (const attachment of result.attachments) {
        const filing = await fileAttachmentAction(emailAccountId, {
          messageId: attachment.messageId,
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
        });
        if (filing?.serverError) throw new Error(filing.serverError);
      }
      toastSuccess({
        description: "Recent attachments processed. See filing activity below.",
      });
    } catch (error) {
      toastError({
        description: error instanceof Error ? error.message : "Preview failed.",
      });
    } finally {
      await refreshFilings();
      setPreviewing(false);
    }
  };
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Set up Paperless filing</h2>
      <DriveConnections />
      <form onSubmit={form.handleSubmit(save.execute)} className="space-y-3">
        <Label htmlFor="paperless-preferences">
          Which attachments should we save?
        </Label>
        <Textarea
          id="paperless-preferences"
          placeholder="Save receipts, invoices, and contracts. Skip marketing material."
          {...form.register("filingPrompt", { required: true })}
        />
        <Button type="submit" loading={save.isExecuting}>
          Save preferences
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Preview processes recent attachments and uploads matching documents to
        Paperless.
      </p>
      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={preview}
          loading={previewing}
          disabled={!data?.filingPrompt || !connected}
        >
          Preview with my recent emails
        </Button>
        <Button
          onClick={() => enable.execute({ filingEnabled: true })}
          loading={enable.isExecuting}
          disabled={!data?.filingPrompt || !connected}
        >
          Start auto-filing
        </Button>
      </div>
      <FilingActivity paperless />
    </div>
  );
}
