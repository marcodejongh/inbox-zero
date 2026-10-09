"use client";

import { useAction } from "next-safe-action/hooks";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { useDriveConnections } from "@/hooks/useDriveConnections";
import { updateFilingDestinationAction } from "@/utils/actions/paperless";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toastError } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { ConnectPaperless } from "./ConnectPaperless";

export function PaperlessSettings() {
  const { emailAccountId } = useAccount();
  const { data: emailAccount, mutate } = useEmailAccountFull();
  const { data } = useDriveConnections();
  const paperless = data?.connections.find(
    (item) => item.provider === "paperless" && item.isConnected,
  );
  const { execute, isExecuting } = useAction(
    updateFilingDestinationAction.bind(null, emailAccountId),
    {
      onSuccess: () => mutate(),
      onError: ({ error }) =>
        toastError({
          description:
            getActionErrorMessage(error) || "Could not change destination.",
        }),
    },
  );
  return (
    <div className="mb-6 flex flex-wrap items-end gap-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label htmlFor="filing-destination">Filing destination</Label>
        <Select
          value={emailAccount?.filingDestination || "cloud"}
          disabled={isExecuting}
          onValueChange={(destination: "cloud" | "paperless") =>
            execute({ destination })
          }
        >
          <SelectTrigger id="filing-destination" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cloud">Cloud drives</SelectItem>
            <SelectItem value="paperless" disabled={!paperless}>
              Paperless
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ConnectPaperless />
      {emailAccount?.filingDestination === "paperless" && (
        <p className="basis-full text-sm text-muted-foreground">
          Inbox Zero selects attachments to save. Paperless handles OCR and
          document organization.
        </p>
      )}
    </div>
  );
}
