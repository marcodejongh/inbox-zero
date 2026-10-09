import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

export async function createPaperlessEmulator() {
  const token = "paperless-emulator-token";
  const uploads: {
    filename: string;
    mimeType: string;
    bytes: Buffer;
    fields: string[];
    taskId: string;
  }[] = [];
  const tasks = new Map<
    string,
    { status: string; related_document: number | null }
  >();
  let redirectTo: string | undefined;
  const server = createServer((request, response) => {
    handle(request)
      .then((result) => {
        response.writeHead(result.status, Object.fromEntries(result.headers));
        return result.arrayBuffer();
      })
      .then((bytes) => response.end(Buffer.from(bytes)))
      .catch(() => {
        response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No emulator port");
  const baseUrl = `http://127.0.0.1:${address.port}/archive`;
  return {
    baseUrl,
    token,
    uploads,
    tasks,
    redirect: (url: string) => {
      redirectTo = url;
    },
    complete: (taskId: string, documentId: number) => {
      tasks.set(taskId, { status: "success", related_document: documentId });
    },
    fail: (taskId: string) => {
      tasks.set(taskId, { status: "failure", related_document: null });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  async function handle(request: IncomingMessage): Promise<Response> {
    if (redirectTo)
      return new Response(null, {
        status: 302,
        headers: { Location: redirectTo },
      });
    if (request.headers.authorization !== `Token ${token}`)
      return Response.json({ detail: "Invalid token" }, { status: 401 });
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/archive/api/documents/")
      return Response.json({ count: 0, results: [] });
    if (request.method === "GET" && url.pathname === "/archive/api/tasks/") {
      const taskId = url.searchParams.get("task_id");
      const results = [...tasks]
        .filter(([id]) => !taskId || id === taskId)
        .map(([id, task]) => ({ task_id: id, ...task }));
      return Response.json(results);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/archive/api/documents/post_document/"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const incoming = new Request(url, {
        method: "POST",
        headers: { "Content-Type": request.headers["content-type"] || "" },
        body: Buffer.concat(chunks),
      });
      const form = await incoming.formData();
      const document = form.get("document");
      if (!(document instanceof File))
        return Response.json({ document: "Required" }, { status: 400 });
      const taskId = randomUUID();
      uploads.push({
        filename: document.name,
        mimeType: document.type,
        bytes: Buffer.from(await document.arrayBuffer()),
        fields: [...form.keys()],
        taskId,
      });
      tasks.set(taskId, { status: "pending", related_document: null });
      return Response.json(taskId);
    }
    return Response.json({ detail: "Not found" }, { status: 404 });
  }
}
