import type { LookupAddress } from "node:dns";
import { Agent, fetch, type RequestInit } from "undici";
import {
  isSafeExternalHttpUrl,
  resolveSafeExternalHttpUrl,
} from "@inboxzero/network/safe-url";

export function getSafeHttpUrlError(url: string, allowPrivateIps: boolean) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password)
      return "URL credentials are not allowed";
    if (!allowPrivateIps && parsed.protocol !== "https:") {
      return "The server URL must use https";
    }
    if (!isSafeExternalHttpUrl(url, { allowPrivateIps })) {
      return "That server URL is not a public address";
    }
    return null;
  } catch {
    return "Invalid server URL";
  }
}

export function createSafeHttpFetch(allowPrivateIps: () => boolean) {
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const host = hostname.includes(":") ? `[${hostname}]` : hostname;
        resolveSafeExternalHttpUrl(`https://${host}`, {
          allowPrivateIps: allowPrivateIps(),
        })
          .then((resolved) => {
            if (!resolved) {
              callback(
                Object.assign(new Error("Not a public host"), {
                  code: "ENOTFOUND",
                }),
                "",
                4,
              );
              return;
            }
            resolved.lookup(
              hostname,
              options,
              callback as (
                error: NodeJS.ErrnoException | null,
                address: string | LookupAddress[],
                family?: number,
              ) => void,
            );
          })
          .catch((error) => callback(error, "", 4));
      },
    },
  });

  return async (url: string, init?: RequestInit) => {
    const error = getSafeHttpUrlError(url, allowPrivateIps());
    if (error) throw new Error(error);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Server redirects are not allowed");
    }
    return response;
  };
}
