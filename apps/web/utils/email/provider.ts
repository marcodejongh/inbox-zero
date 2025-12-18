import {
  getGmailClientForEmail,
  getOutlookClientForEmail,
  getImapCredentialsForEmail,
} from "@/utils/account";
import { GmailProvider } from "@/utils/email/google";
import { OutlookProvider } from "@/utils/email/microsoft";
import { ImapProvider } from "@/utils/email/imap";
import {
  isGoogleProvider,
  isMicrosoftProvider,
  isImapProvider,
} from "@/utils/email/provider-types";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";

export async function createEmailProvider({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger?: Logger;
}): Promise<EmailProvider> {
  if (isGoogleProvider(provider)) {
    const client = await getGmailClientForEmail({ emailAccountId });
    return new GmailProvider(client, logger);
  } else if (isMicrosoftProvider(provider)) {
    const client = await getOutlookClientForEmail({ emailAccountId });
    return new OutlookProvider(client, logger);
  } else if (isImapProvider(provider)) {
    const credentials = await getImapCredentialsForEmail({ emailAccountId });
    if (!credentials) {
      throw new Error(`IMAP credentials not found for account: ${emailAccountId}`);
    }
    return new ImapProvider(
      credentials.imap,
      credentials.smtp,
      credentials.email,
      logger,
    );
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
