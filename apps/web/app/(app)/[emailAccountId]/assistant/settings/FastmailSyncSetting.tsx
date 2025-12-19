"use client";

import { SettingCard } from "@/components/SettingCard";
import { FastmailSyncButton } from "@/components/FastmailSyncButton";
import { useAccount } from "@/providers/EmailAccountProvider";
import { isFastmailProvider } from "@/utils/email/provider-types";

export function FastmailSyncSetting() {
  const { provider } = useAccount();

  // Only show for Fastmail accounts
  if (!isFastmailProvider(provider)) {
    return null;
  }

  return (
    <SettingCard
      title="Email Sync"
      description="Fastmail doesn't support real-time push notifications. Use this button to manually check for new emails and run your automation rules."
      right={<FastmailSyncButton />}
    />
  );
}
