import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { Client } from "pg";
import { test } from "../playwright-test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { createPaperlessEmulator } from "@/__tests__/emulators/paperless";
import {
  openAttachments,
  resetAttachmentTestState,
  setupAttachmentTestState,
} from "./attachment-test-helpers";
import { conversationWithSubject, openMail } from "../mail/mail-test-helpers";
import { getEmailAccountId } from "../account-test-helpers";

let paperless: Awaited<ReturnType<typeof createPaperlessEmulator>>;
test.beforeAll(async () => {
  paperless = await createPaperlessEmulator();
});
test.afterAll(async () => {
  await paperless.close();
});
test.beforeEach(async () => {
  await setupAttachmentTestState();
  paperless.uploads.length = 0;
  paperless.tasks.clear();
});
test.afterEach(async () => {
  await resetAttachmentTestState();
});

test("connects Paperless, saves while paused, and shows the consumed document", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await connectPaperless(page);
  await expect(page.getByText("Allowed folders", { exact: true })).toHaveCount(
    0,
  );
  const { conversations, emailAccountId } = await openMail(page);
  await conversationWithSubject(
    page,
    conversations,
    "Re: Reader Visual Message",
  ).click();
  const save = page.getByRole("button", {
    name: "Save reader-preview.png to Paperless",
  });
  await expect(save).toBeVisible({ timeout: 60_000 });
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(() => paperless.uploads.length).toBe(1);
  expect(paperless.uploads[0].filename).toBe("reader-preview.png");
  expect(paperless.uploads[0].bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await page.goto(`/${emailAccountId}/drive`);
  await expect(page.getByText("Processing in Paperless")).toBeVisible();
  await capturePlaywrightCheckpoint(
    page.getByText("Recent Activity", { exact: true }).locator(".."),
    testInfo,
    "paperless-processing",
  );
  await completeUpload(page);
  await page.reload();
  const link = page.getByRole("link", {
    name: "Open reader-preview.png in Paperless",
  });
  await expect(link).toHaveAttribute(
    "href",
    `${paperless.baseUrl}/documents/42/details`,
  );
  await expect(page.getByText("Saved to Paperless")).toBeVisible();
  expect(paperless.uploads).toHaveLength(1);
  await capturePlaywrightCheckpoint(
    page.getByText("Recent Activity", { exact: true }).locator(".."),
    testInfo,
    "paperless-filed",
  );
});

test("asks for uncertain documents and uploads only after confirmation", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await connectPaperless(page);
  await page
    .getByLabel("Which attachments should we save?")
    .fill("Save receipts and invoices. Ask when uncertain.");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview with my recent emails" }),
  ).toBeEnabled();
  const scripted = await page.request.post(
    `${process.env.PLAYWRIGHT_LLM_BASE_URL}/__emulator/replies`,
    {
      data: {
        match: "Decide whether an email attachment",
        object: {
          action: "save",
          confidence: 0.4,
          reasoning: "This document needs confirmation.",
        },
      },
    },
  );
  expect(scripted.ok()).toBe(true);
  await page
    .getByRole("button", { name: "Preview with my recent emails" })
    .click();
  await expect(page.getByText("Confirm saving?")).toBeVisible({
    timeout: 120_000,
  });
  expect(paperless.uploads).toHaveLength(0);
  await capturePlaywrightCheckpoint(
    page.getByText("Recent Activity", { exact: true }).locator(".."),
    testInfo,
    "paperless-confirmation",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Processing in Paperless")).toBeVisible();
  expect(paperless.uploads).toHaveLength(1);
  await completeUpload(page);
  await page.reload();
  await expect(page.getByText("Saved to Paperless")).toBeVisible();
  expect(paperless.uploads).toHaveLength(1);
});

async function connectPaperless(page: Page) {
  await openAttachments(page);
  await page
    .getByRole("button", { name: "Connect Paperless", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect Paperless" });
  await dialog.getByLabel("Instance URL").fill(paperless.baseUrl);
  await dialog.getByLabel("API token").fill(paperless.token);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const accountId = await getEmailAccountId(page);
  const connections = await page.request.get("/api/user/drive/connections", {
    headers: { "X-Email-Account-ID": accountId },
  });
  const connectionData = await connections.json();
  expect(JSON.stringify(connectionData)).not.toContain(paperless.token);
  await expect(page.getByLabel("Filing destination")).toHaveText(
    "Cloud drives",
  );
  await expect(page.getByText("Google Drive", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add folder" }).click();
  const folderDialog = page.getByRole("dialog", { name: "Create folder" });
  const folderName = `Cloud folder with Paperless connected ${Date.now()}`;
  await folderDialog.getByLabel("Folder name").fill(folderName);
  await folderDialog.getByRole("button", { name: "Create folder" }).click();
  await expect(folderDialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText(folderName, { exact: true })).toBeVisible();
  await page.getByLabel("Filing destination").click();
  await page.getByRole("option", { name: "Paperless", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Set up Paperless filing" }),
  ).toBeVisible();
}

async function completeUpload(page: Page) {
  paperless.complete(paperless.uploads[0].taskId, 42);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      'UPDATE "DocumentFiling" SET "updatedAt" = NOW() - INTERVAL \'2 minutes\' WHERE "paperlessTaskId" = $1',
      [paperless.uploads[0].taskId],
    );
  } finally {
    await client.end();
  }
  const response = await page.request.get("/api/cron/paperless-filings", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  expect(response.ok()).toBe(true);
}
