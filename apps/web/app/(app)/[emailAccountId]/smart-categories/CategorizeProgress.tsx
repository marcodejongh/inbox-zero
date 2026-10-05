"use client";

import { useEffect, useState } from "react";
import { atom, useAtom } from "jotai";
import useSWR from "swr";
import { ProgressPanel } from "@/components/ProgressPanel";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import { useAccount } from "@/providers/EmailAccountProvider";
import { bulkCategorizeSendersAction } from "@/utils/actions/categorize";
import type { CategorizeProgress } from "@/app/api/user/categorize/senders/progress/route";

const isCategorizeInProgressAtom = atom(false);

export function useCategorizeProgress() {
  const [isBulkCategorizing, setIsBulkCategorizing] = useAtom(
    isCategorizeInProgressAtom,
  );
  return { isBulkCategorizing, setIsBulkCategorizing };
}

export function CategorizeSendersProgress({
  refresh = false,
}: {
  refresh: boolean;
}) {
  const { isBulkCategorizing } = useCategorizeProgress();
  const { emailAccountId } = useAccount();
  const [isRetrying, setIsRetrying] = useState(false);

  const { data, mutate } = useSWR<CategorizeProgress>(
    "/api/user/categorize/senders/progress",
    {
      refreshInterval: refresh || isBulkCategorizing ? 1000 : undefined,
    },
  );

  const { setIsBulkCategorizing } = useCategorizeProgress();
  const processedItems = data
    ? data.completedItems + (data.failedItems ?? 0)
    : undefined;
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | undefined;
    if (processedItems === data?.totalItems) {
      timeoutId = setTimeout(() => {
        setIsBulkCategorizing(false);
      }, 3000);
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [processedItems, data?.totalItems, setIsBulkCategorizing]);

  if (!data?.totalItems) return null;

  const totalItems = data.totalItems || 0;
  const completedItems = data.completedItems || 0;
  const failedItems = data.failedItems ?? 0;
  const remainingItems = Math.max(totalItems - completedItems - failedItems, 0);

  const retryFailed = async () => {
    setIsRetrying(true);
    setIsBulkCategorizing(true);
    try {
      const result = await bulkCategorizeSendersAction(emailAccountId);
      if (result?.serverError) throw new Error(result.serverError);
      if (!result?.data?.totalUncategorizedSenders)
        setIsBulkCategorizing(false);
      mutate();
    } catch (error) {
      setIsBulkCategorizing(false);
      toastError({
        description: error instanceof Error ? error.message : "Failed to retry",
      });
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <>
      <ProgressPanel
        totalItems={totalItems}
        remainingItems={remainingItems}
        inProgressText="Categorizing senders..."
        completedText={
          failedItems > 0
            ? `${completedItems} categorized, ${failedItems} failed.`
            : `Categorization complete! ${completedItems} categorized!`
        }
        itemLabel="senders"
        hasFailures={failedItems > 0}
      />
      {failedItems > 0 && remainingItems === 0 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={isRetrying}
          onClick={retryFailed}
        >
          Retry failed senders
        </Button>
      )}
    </>
  );
}
