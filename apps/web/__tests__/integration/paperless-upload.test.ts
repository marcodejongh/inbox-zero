import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaperlessEmulator } from "@/__tests__/emulators/paperless";
import { PaperlessClient } from "@/utils/paperless/client";

vi.mock("@/env", () => ({ env: { PAPERLESS_ALLOW_PRIVATE_IPS: true } }));

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "Paperless HTTP integration",
  () => {
    let emulator: Awaited<ReturnType<typeof createPaperlessEmulator>>;
    beforeEach(async () => {
      emulator = await createPaperlessEmulator();
    });
    afterEach(async () => {
      await emulator.close();
    });

    it("uploads original bytes and follows a pending task to its document", async () => {
      const client = new PaperlessClient(emulator.baseUrl, emulator.token);
      await client.validateConnection();
      const bytes = Buffer.from([0, 1, 2, 255, 10, 42]);
      const taskId = await client.upload({
        content: bytes,
        filename: "résumé.pdf",
        mimeType: "application/pdf",
      });
      expect(emulator.uploads[0]).toMatchObject({
        filename: "résumé.pdf",
        mimeType: "application/pdf",
        bytes,
        fields: ["document"],
        taskId,
      });
      expect(await client.getTask(taskId)).toEqual({ status: "processing" });
      emulator.complete(taskId, 123);
      expect(await client.getTask(taskId)).toEqual({
        status: "filed",
        documentId: "123",
        webUrl: `${emulator.baseUrl}/documents/123/details`,
      });
      expect(emulator.uploads).toHaveLength(1);
    });
    it("requires an API token and never follows a login redirect", async () => {
      await expect(
        new PaperlessClient(emulator.baseUrl, "wrong").validateConnection(),
      ).rejects.toThrow("rejected the API token");
      emulator.redirect("http://127.0.0.1:1/login");
      await expect(
        new PaperlessClient(
          emulator.baseUrl,
          emulator.token,
        ).validateConnection(),
      ).rejects.toThrow("Could not reach Paperless");
      expect(emulator.uploads).toHaveLength(0);
    });
  },
);
