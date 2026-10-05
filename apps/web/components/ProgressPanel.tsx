"use client";

import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/utils";
import { LoadingMiniSpinner } from "@/components/Loading";
import { Progress } from "@/components/ui/progress";

export function ProgressPanel({
  totalItems,
  remainingItems,
  inProgressText,
  completedText,
  itemLabel,
  hasFailures = false,
}: {
  totalItems: number;
  remainingItems: number;
  inProgressText: string;
  completedText: string;
  itemLabel: string;
  hasFailures?: boolean;
}) {
  const totalProcessed = totalItems - remainingItems;
  const progress = (totalProcessed / totalItems) * 100;
  const isCompleted = progress === 100;
  const completedColor = hasFailures
    ? { bar: "bg-amber-500", text: "text-amber-600" }
    : { bar: "bg-green-500", text: "text-green-500" };

  if (!totalItems) return null;

  return (
    <div className="pt-4 pb-2">
      <AnimatePresence mode="wait">
        <motion.div
          key="progress"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          <Progress
            value={progress}
            innerClassName={isCompleted ? completedColor.bar : "bg-blue-500"}
          />
          <div className="mt-2 flex justify-between text-sm" aria-live="polite">
            <span
              className={cn(
                "text-muted-foreground",
                isCompleted ? completedColor.text : "",
              )}
            >
              {isCompleted ? (
                completedText
              ) : (
                <div className="flex items-center gap-1">
                  <LoadingMiniSpinner />
                  <span>{inProgressText}</span>
                </div>
              )}
            </span>
            <span>
              {totalProcessed} of {totalItems} {itemLabel} processed
            </span>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
