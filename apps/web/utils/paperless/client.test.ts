import { beforeEach, describe, expect, it, vi } from "vitest";

const { request, settings } = vi.hoisted(() => ({
  request: vi.fn(),
  settings: { PAPERLESS_ALLOW_PRIVATE_IPS: false },
}));
vi.mock("@/env", () => ({ env: settings }));
vi.mock("@/utils/network/safe-fetch", async (original) => {
  const actual = await original<typeof import("@/utils/network/safe-fetch")>();
  return { ...actual, createSafeHttpFetch: () => request };
});
import { normalizePaperlessUrl, PaperlessClient } from "./client";

const taskId = "12345678-1234-4234-8234-123456789abc";
const client = () =>
  new PaperlessClient("https://paperless.example.com/archive/", "secret-token");

describe("Paperless API", () => {
  beforeEach(() => {
    request.mockReset();
    settings.PAPERLESS_ALLOW_PRIVATE_IPS = false;
  });
  it("keeps subpaths and normalizes trailing slashes", () => {
    expect(
      normalizePaperlessUrl("https://paperless.example.com/archive///"),
    ).toBe("https://paperless.example.com/archive");
  });
  it.each([
    "https://user:password@example.com",
    "https://10.0.0.1",
    "http://example.com",
    "https://example.com?token=x",
    "https://example.com#fragment",
  ])("refuses unsafe instance URL %s", (url) => {
    expect(() => normalizePaperlessUrl(url)).toThrow();
  });
  it("allows private HTTP targets only with the Paperless opt-in", () => {
    settings.PAPERLESS_ALLOW_PRIVATE_IPS = true;
    expect(normalizePaperlessUrl("http://192.168.1.20:8000")).toBe(
      "http://192.168.1.20:8000",
    );
  });
  it("uploads original bytes and filename with token auth", async () => {
    request.mockResolvedValue(Response.json(taskId));
    expect(
      await client().upload({
        content: Buffer.from("document bytes"),
        filename: "receipt.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe(taskId);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      "https://paperless.example.com/archive/api/documents/post_document/",
    );
    expect(init.headers.Authorization).toBe("Token secret-token");
    const document = init.body.get("document");
    expect(document.name).toBe("receipt.pdf");
    expect(await document.text()).toBe("document bytes");
    expect(init.body.has("tags")).toBe(false);
    expect(init.body.has("created")).toBe(false);
  });
  it("refuses a proxy page masquerading as the tasks API", async () => {
    request
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ login: "required" }));
    await expect(client().validateConnection()).rejects.toThrow(
      "supported Paperless API response",
    );
  });
  it.each([
    "pending",
    "started",
    "PENDING",
    "STARTED",
  ])("keeps %s tasks processing", async (status) => {
    request.mockResolvedValue(Response.json([{ task_id: taskId, status }]));
    expect(await client().getTask(taskId)).toEqual({ status: "processing" });
  });
  it("resolves consumed document IDs and immutable document links", async () => {
    request.mockResolvedValue(
      Response.json({
        results: [
          {
            task_id: taskId,
            status: "success",
            result_data: { document_id: 42 },
          },
        ],
      }),
    );
    expect(await client().getTask(taskId)).toEqual({
      status: "filed",
      documentId: "42",
      webUrl: "https://paperless.example.com/archive/documents/42/details",
    });
  });
  it("links a duplicate document instead of treating it as a failed save", async () => {
    request.mockResolvedValue(
      Response.json([
        {
          task_id: taskId,
          status: "failure",
          result_data: { duplicate_of: 42 },
        },
      ]),
    );
    expect((await client().getTask(taskId)).status).toBe("filed");
  });
  it("does not borrow the document ID of an unrelated task", async () => {
    request.mockResolvedValue(
      Response.json([
        {
          task_id: "unrelated",
          status: "success",
          result_data: { document_id: 42 },
        },
      ]),
    );
    expect(await client().getTask(taskId)).toEqual({ status: "missing" });
  });
  it("rejects an accepted upload lacking a task ID", async () => {
    request.mockResolvedValue(Response.json("OK"));
    await expect(
      client().upload({
        content: Buffer.from("x"),
        filename: "doc.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow("Check Paperless before retrying");
  });
  it("does not expose API response bodies or credentials in errors", async () => {
    request.mockResolvedValue(
      new Response("secret-token private document contents", { status: 401 }),
    );
    await expect(client().getTask(taskId)).rejects.toThrow(
      "rejected the API token",
    );
  });
  it("treats network errors as a safe connectivity error", async () => {
    request.mockRejectedValue(new Error("secret-token transport error"));
    await expect(client().getTask(taskId)).rejects.toThrow(
      "Could not reach Paperless",
    );
  });
});
