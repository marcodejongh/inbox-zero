import { z } from "zod";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import { createGenerateObject } from "@/utils/llms";

const system = `You are a document filing assistant. The user received one notification about one or more document attachments. They have replied to that email.

Determine which documents they mean and always provide a reply to send back.

Actions:
- "approve": User is happy with the filing. We will mark it as approved in the database.
- "move": User wants the document in a different folder. We will move the file to the path they specify.
- "undo": User wants to reverse the filing. We will move the file to a "To Delete" folder for them to review.

Paperless filings have no folders. For a pending Paperless filing, approve means upload and undo means skip. For an already filed Paperless document, approve means feedback only; organization and removal must be done in Paperless. Never propose a move or undo action for an already saved Paperless document. Describe a requested pending approval as starting processing, not as completed filing.

Return at most one action per filing. Use only filing IDs from the provided list. If the user names documents, act only on those documents. If their reply clearly applies to every document, return an action for each one. If it is ambiguous which document they mean, return no actions and ask them to identify it.

Always write a helpful, concise reply.`;

const schema = z.object({
  actions: z.array(
    z.object({
      filingId: z
        .string()
        .describe("The exact filing ID from the provided filing list"),
      action: z.enum(["approve", "move", "undo"]),
      folderPath: z
        .string()
        .nullable()
        .describe("The destination path for move; null for other actions"),
    }),
  ),
  reply: z.string(),
});

export type ParseFilingReplyResult = z.infer<typeof schema>;

interface FilingContext {
  currentFolder: string;
  destination?: "cloud" | "paperless";
  filename: string;
  id: string;
  status?: string;
}

type Message = { role: "user" | "assistant"; content: string };

export async function aiParseFilingReply({
  messages,
  filingContexts,
  emailAccount,
}: {
  messages: Message[];
  filingContexts: FilingContext[];
  emailAccount: EmailAccountWithAI;
}): Promise<ParseFilingReplyResult> {
  if (!messages.length) {
    return { actions: [], reply: "" };
  }

  const formattedMessages = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const prompt = `<filings>
${filingContexts
  .map(
    (filing) => `<filing id="${filing.id}">
Document: ${JSON.stringify(filing.filename)}
Current folder: ${JSON.stringify(filing.currentFolder)}
Destination: ${JSON.stringify(filing.destination || "cloud")}
Status: ${JSON.stringify(filing.status || "FILED")}
</filing>`,
  )
  .join("\n")}
</filings>

<conversation>
${formattedMessages}
</conversation>

${emailAccount.about ? `<user_info>${emailAccount.about}</user_info>` : ""}

Determine the action and write a reply.`;

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.ParseFilingReply,
  );

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Parse filing reply",
    modelOptions,
    promptHardening: { trust: "trusted" },
  });

  const result = await generateObject({
    ...modelOptions,
    instructions: system,
    prompt,
    schema,
  });

  return result.object;
}
