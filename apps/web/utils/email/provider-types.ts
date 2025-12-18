export function isGoogleProvider(provider: string | null | undefined) {
  return provider === "google";
}

export function isMicrosoftProvider(provider: string | null | undefined) {
  return provider === "microsoft";
}

export function isImapProvider(provider: string | null | undefined) {
  return provider === "imap";
}
