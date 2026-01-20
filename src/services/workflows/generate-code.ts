import { generateText } from "ai";
import type { GenerateTextOptions } from "./schemas";

export function extractCodeFromMarkdown(markdown: string): string | null {
  const regex = /```(?:[^\n]*)\n([\s\S]*?)```\n?/;
  const match = markdown.match(regex);
  if (match) {
    return match[1];
  }
  const startTagIndex = markdown.indexOf("```");
  if (startTagIndex === -1) return null;
  const firstLineEndIndex = markdown.indexOf("\n", startTagIndex);
  if (firstLineEndIndex === -1) return "";
  const codeStartIndex = firstLineEndIndex + 1;
  const endTagIndex = markdown.indexOf("```", codeStartIndex);
  if (endTagIndex !== -1) {
    return markdown.substring(codeStartIndex, endTagIndex);
  } else {
    return markdown.substring(codeStartIndex);
  }
}

export async function generateCode(options: GenerateTextOptions) {
  const { text } = await generateText(options);
  return extractCodeFromMarkdown(text) || text;
}
