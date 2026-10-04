"use client";

import { useAction } from "next-safe-action/hooks";
import { LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  confirmPaperlessFilingAction,
  rejectPaperlessFilingAction,
  retryPaperlessFilingAction,
} from "@/utils/actions/paperless";
import { toastError } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";

export function PaperlessFilingStatus({
  filingId,
  status,
  errorMessage,
  onUpdated,
}: {
  filingId: string;
  status: string;
  errorMessage?: string | null;
  onUpdated: () => void;
}) {
  const { emailAccountId } = useAccount();
  const callbacks = {
    onSuccess: () => onUpdated(),
    onError: ({
      error,
    }: {
      error: Parameters<typeof getActionErrorMessage>[0];
    }) =>
      toastError({
        description: getActionErrorMessage(error) || "Could not update filing.",
      }),
  };
  const approve = useAction(
    confirmPaperlessFilingAction.bind(null, emailAccountId),
    callbacks,
  );
  const reject = useAction(
    rejectPaperlessFilingAction.bind(null, emailAccountId),
    callbacks,
  );
  const retry = useAction(
    retryPaperlessFilingAction.bind(null, emailAccountId),
    callbacks,
  );
  if (status === "PROCESSING")
    return (
      <span className="flex items-center gap-2">
        <LoaderIcon className="size-4 animate-spin" />
        Processing in Paperless
      </span>
    );
  if (status === "PENDING")
    return (
      <div className="flex items-center gap-2">
        <span>Confirm saving?</span>
        <Button
          size="sm"
          onClick={() => approve.execute({ filingId })}
          loading={approve.isExecuting}
          disabled={reject.isExecuting}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reject.execute({ filingId })}
          loading={reject.isExecuting}
          disabled={approve.isExecuting}
        >
          Skip
        </Button>
      </div>
    );
  if (status === "ERROR")
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          {errorMessage || "Paperless filing failed."}
        </p>
        <Button
          size="sm"
          variant="outline"
          loading={retry.isExecuting}
          onClick={() => {
            if (
              confirm(
                "Check Paperless first: this attachment may already have been uploaded. Retry saving it?",
              )
            )
              retry.execute({ filingId });
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (status === "PREVIEW" || status === "REJECTED")
    return <span className="text-muted-foreground">Skipped</span>;
  return <span>Saved to Paperless</span>;
}
