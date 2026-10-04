import "server-only";
import { FormData } from "undici";
import { z } from "zod";
import { env } from "@/env";
import { SafeError } from "@/utils/error";
import {
  createSafeHttpFetch,
  getSafeHttpUrlError,
} from "@/utils/network/safe-fetch";

const fetchPaperless = createSafeHttpFetch(
  () => env.PAPERLESS_ALLOW_PRIVATE_IPS,
);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const taskSchema = z.object({
  task_id: z.string(),
  status: z.string(),
  related_document: z.union([z.number(), z.string()]).nullish(),
  result_data: z
    .object({
      document_id: z.number().int().positive().optional(),
      duplicate_of: z.number().int().positive().optional(),
    })
    .nullish(),
});
const taskListSchema = z.union([
  z.array(taskSchema),
  z.object({ results: z.array(taskSchema) }),
]);

export class PaperlessHttpError extends SafeError {
  constructor(status: number) {
    const message =
      status === 401
        ? "Paperless rejected the API token. Reconnect Paperless with a valid token."
        : status === 403
          ? "The Paperless user needs permission to view tasks and view/add documents."
          : status === 400
            ? "Paperless rejected this document. Check its file type and Paperless configuration."
            : `Paperless returned HTTP ${status}. Please try again.`;
    super(message, status);
  }
}

export function normalizePaperlessUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.search || parsed.hash)
    throw new SafeError(
      "Use the Paperless instance URL without a query or fragment.",
    );
  const error = getSafeHttpUrlError(
    parsed.toString(),
    env.PAPERLESS_ALLOW_PRIVATE_IPS,
  );
  if (error) throw new SafeError(error);
  return parsed.toString().replace(/\/+$/, "");
}

export class PaperlessClient {
  readonly baseUrl: string;
  private readonly token: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizePaperlessUrl(baseUrl);
    this.token = token;
    if (!token) throw new SafeError("Reconnect Paperless with an API token.");
  }

  async validateConnection() {
    for (const path of [
      "api/documents/?page_size=1",
      "api/tasks/?page_size=1",
    ]) {
      const response = await this.request(path);
      const schema = path.startsWith("api/documents/")
        ? z.object({ results: z.array(z.unknown()) })
        : taskListSchema;
      const parsed = schema.safeParse(await this.readJson(response));
      if (!parsed.success) {
        throw new SafeError(
          "The URL did not return a supported Paperless API response.",
        );
      }
    }
  }

  async upload({
    content,
    filename,
    mimeType,
  }: {
    content: Buffer;
    filename: string;
    mimeType: string;
  }) {
    const form = new FormData();
    form.append(
      "document",
      new Blob([new Uint8Array(content)], { type: mimeType }),
      filename,
    );
    const response = await this.request("api/documents/post_document/", {
      method: "POST",
      body: form,
    });
    const taskId = z
      .string()
      .uuid()
      .safeParse(await this.readJson(response));
    if (!taskId.success)
      throw new SafeError(
        "Paperless accepted the request but did not return a task ID. Check Paperless before retrying.",
      );
    return taskId.data;
  }

  async getTask(taskId: string) {
    const response = await this.request(
      `api/tasks/?task_id=${encodeURIComponent(taskId)}`,
    );
    const parsed = taskListSchema.safeParse(await this.readJson(response));
    if (!parsed.success)
      throw new SafeError("Paperless returned an unsupported task response.");
    const tasks = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data.results;
    const task = tasks.find((item) => item.task_id === taskId);
    if (!task) return { status: "missing" as const };
    const status = task.status.toLowerCase();
    const documentId =
      task.result_data?.document_id ??
      task.result_data?.duplicate_of ??
      Number(task.related_document);
    if (
      (status === "success" || task.result_data?.duplicate_of) &&
      Number.isSafeInteger(documentId) &&
      documentId > 0
    ) {
      return {
        status: "filed" as const,
        documentId: String(documentId),
        webUrl: `${this.baseUrl}/documents/${documentId}/details`,
      };
    }
    if (["failure", "revoked"].includes(status))
      return { status: "error" as const };
    if (status === "success")
      throw new SafeError(
        "Paperless completed the task without a document ID.",
      );
    return { status: "processing" as const };
  }

  private async request(
    path: string,
    init?: Parameters<typeof fetchPaperless>[1],
  ) {
    let response: Awaited<ReturnType<typeof fetchPaperless>>;
    try {
      response = await fetchPaperless(`${this.baseUrl}/${path}`, {
        ...init,
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: "application/json",
          ...init?.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SafeError(
        "Could not reach Paperless. Check the instance URL and network access.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PaperlessHttpError(response.status);
    }
    return response;
  }
  private async readJson(response: Awaited<ReturnType<typeof fetchPaperless>>) {
    try {
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new SafeError("Paperless returned an oversized API response.");
      }
      if (!response.body) throw new Error("Empty response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new SafeError(
              "Paperless returned an oversized API response.",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError("Paperless returned an unsupported API response.");
    }
  }
}
