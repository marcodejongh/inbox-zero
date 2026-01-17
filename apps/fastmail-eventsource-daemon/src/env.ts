import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    MAIN_APP_URL: z.string().url(),
    FASTMAIL_WEBHOOK_SECRET: z.string().min(1),
    FASTMAIL_CLIENT_ID: z.string().optional(),
    FASTMAIL_CLIENT_SECRET: z.string().optional(),
    ACCOUNT_REFRESH_INTERVAL: z.coerce.number().default(300_000), // 5 minutes
    DEBUG: z.coerce.boolean().default(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
