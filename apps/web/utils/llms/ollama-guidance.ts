import { Provider } from "@/utils/llms/config";

type ProviderLike = {
  provider: string;
};

export function isOllamaProvider(provider: string) {
  return provider === Provider.OLLAMA;
}

export function appendOllamaOnlySystemGuidance<
  OPTIONS extends { instructions?: unknown },
>(
  options: OPTIONS,
  modelOptions: ProviderLike,
  guidance: readonly string[],
): OPTIONS {
  if (!isOllamaProvider(modelOptions.provider)) return options;

  return {
    ...options,
    instructions: appendSystemGuidance(options.instructions, guidance),
  };
}

// Local OpenAI-compatible servers drift out of JSON mode the same way Ollama
// does when the prompt never asks for JSON.
export function appendStructuredOutputGuidance<
  OPTIONS extends { instructions?: unknown },
>(options: OPTIONS, modelOptions: ProviderLike): OPTIONS {
  if (
    modelOptions.provider !== Provider.OLLAMA &&
    modelOptions.provider !== Provider.OPENAI_COMPATIBLE
  )
    return options;

  return {
    ...options,
    instructions: appendSystemGuidance(
      options.instructions,
      STRUCTURED_OUTPUT_GUIDANCE,
    ),
  };
}

function appendSystemGuidance(
  system: unknown,
  guidance: readonly string[],
): string {
  const currentSystem = typeof system === "string" ? system.trimEnd() : "";
  const extraGuidance = guidance.join("\n");

  return currentSystem ? `${currentSystem}\n\n${extraGuidance}` : extraGuidance;
}

const STRUCTURED_OUTPUT_GUIDANCE = [
  "Return only valid JSON that matches the requested schema.",
  "The top-level JSON value must match the schema root exactly; do not return a nested item by itself.",
  "Do not include markdown, bullets, code fences, explanations, or any text outside the JSON.",
  "If a schema field asks for prose, put that prose inside the appropriate JSON string field.",
] as const;
