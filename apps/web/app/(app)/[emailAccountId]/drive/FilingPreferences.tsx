"use client";

import { useAccount } from "@/providers/EmailAccountProvider";
import { FilingRulesForm } from "./FilingRulesForm";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { AllowedFolders } from "./AllowedFolders";

export function FilingPreferences() {
  const { emailAccountId } = useAccount();
  const { data } = useEmailAccountFull();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data?.filingDestination !== "paperless" && (
        <AllowedFolders emailAccountId={emailAccountId} />
      )}
      <FilingRulesForm emailAccountId={emailAccountId} />
    </div>
  );
}
