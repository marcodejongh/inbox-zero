import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { hasCronSecret } from "@/utils/cron";
import { reconcilePaperlessFilings } from "@/utils/paperless/reconcile";

export const maxDuration = 300;
export const GET = withError("cron/paperless-filings", async (request) => {
  if (!hasCronSecret(request))
    return new Response("Unauthorized", { status: 401 });
  return NextResponse.json(await reconcilePaperlessFilings(request.logger));
});
