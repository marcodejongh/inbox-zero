import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestInit } from "undici";
import { env } from "@/env";
import type { ResolvedMcpIntegration } from "@/utils/mcp/resolve-integration";
import {
  createSafeHttpFetch,
  getSafeHttpUrlError,
} from "@/utils/network/safe-fetch";

const fetchMcp = createSafeHttpFetch(() => env.MCP_ALLOW_PRIVATE_IPS);

export function getMcpFetch(
  integration: ResolvedMcpIntegration,
): FetchLike | undefined {
  return integration.isCustom ? safeMcpFetch : undefined;
}

export function getCustomMcpServerUrlError(url: string): string | null {
  return getSafeHttpUrlError(url, env.MCP_ALLOW_PRIVATE_IPS);
}

const safeMcpFetch: FetchLike = async (url, init) =>
  (await fetchMcp(url.toString(), init as RequestInit)) as unknown as Response;
