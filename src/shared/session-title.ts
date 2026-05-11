import type { ProviderChatResponse } from "./contracts";

const TITLE_REQUEST_MARKER =
  "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session.";
const TITLE_RESPONSE_MARKER = 'Return JSON with a single "title" field.';

type MessageLike = {
  role: "system" | "user" | "assistant";
  content: string;
};

function stripSystemReminderBlocks(text: string) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function buildTitleSeed(messages: MessageLike[]) {
  const latestUserContent = [...messages]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) => collapseWhitespace(stripSystemReminderBlocks(message.content)))
    .find((content) => content.length > 0);

  if (!latestUserContent) {
    return "Coding session";
  }

  return latestUserContent
    .replace(/^\[Request interrupted by user\]\s*/i, "")
    .replace(/[.!?。！？,:;]+$/u, "")
    .trim();
}

function toSessionTitle(seed: string) {
  if (seed.length === 0) {
    return "Coding session";
  }

  if (/[^\u0000-\u007f]/.test(seed)) {
    return seed.slice(0, 24);
  }

  const limited = seed
    .split(/\s+/)
    .slice(0, 7)
    .join(" ")
    .slice(0, 60)
    .trim();

  if (limited.length === 0) {
    return "Coding session";
  }

  return limited.charAt(0).toUpperCase() + limited.slice(1);
}

export function isSessionTitleRequest(messages: MessageLike[]) {
  const systemContent = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return (
    systemContent.includes(TITLE_REQUEST_MARKER) &&
    systemContent.includes(TITLE_RESPONSE_MARKER)
  );
}

export function buildSessionTitleResponse(
  messages: MessageLike[],
): ProviderChatResponse {
  const title = toSessionTitle(buildTitleSeed(messages));

  return {
    mode: "text",
    outputText: JSON.stringify({ title }),
    finishReason: "stop",
  };
}
