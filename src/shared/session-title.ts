import type { ProviderChatResponse } from "./contracts";

const LEGACY_TITLE_REQUEST_MARKER =
  "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session.";
const LEGACY_TITLE_RESPONSE_MARKER = 'Return JSON with a single "title" field.';
const KEBAB_NAME_REQUEST_MARKER = "Generate a short kebab-case name";
const KEBAB_NAME_RESPONSE_MARKER = 'Return JSON with a "name" field.';

type MessageLike = {
  role: "system" | "user" | "assistant";
  content: string;
};

function stripSystemReminderBlocks(text: string) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
}

function stripConversationTags(text: string) {
  return text.replace(/<\/?conversation>/gi, " ");
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function buildTitleSeed(messages: MessageLike[]) {
  const latestUserContent = [...messages]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) =>
      collapseWhitespace(
        stripConversationTags(stripSystemReminderBlocks(message.content)),
      ),
    )
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

function detectSessionTitleFormat(messages: MessageLike[]) {
  const systemContent = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  if (
    systemContent.includes(LEGACY_TITLE_REQUEST_MARKER) &&
    systemContent.includes(LEGACY_TITLE_RESPONSE_MARKER)
  ) {
    return "title" as const;
  }

  if (
    systemContent.includes(KEBAB_NAME_REQUEST_MARKER) &&
    systemContent.includes(KEBAB_NAME_RESPONSE_MARKER)
  ) {
    return "name" as const;
  }

  return null;
}

function toSessionName(seed: string) {
  const hintedParts = [
    /electron/i.test(seed) ? "electron" : null,
    /frontend|前端/u.test(seed) ? "frontend" : null,
    /refactor|重构/u.test(seed) ? "refactor" : null,
    /styles?|样式|design|设计/u.test(seed) ? "styles" : null,
    /auth|登录|signin|login/u.test(seed) ? "auth" : null,
    /test|测试/u.test(seed) ? "tests" : null,
    /gateway|网关/u.test(seed) ? "gateway" : null,
  ].filter((part): part is string => part !== null);

  if (hintedParts.length >= 2) {
    return hintedParts.slice(0, 4).join("-");
  }

  const stopWords = new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "be",
    "by",
    "coding",
    "context",
    "conversation",
    "current",
    "field",
    "file",
    "files",
    "for",
    "from",
    "html",
    "in",
    "is",
    "it",
    "js",
    "json",
    "of",
    "on",
    "or",
    "project",
    "renderer",
    "return",
    "scss",
    "section",
    "session",
    "src",
    "styles",
    "that",
    "the",
    "this",
    "to",
    "tsx",
    "ui",
    "with",
  ]);
  const asciiWords = Array.from(seed.toLowerCase().matchAll(/[a-z0-9]+/g))
    .map((match) => match[0])
    .filter((word) => !stopWords.has(word));
  const uniqueWords = [...new Set(asciiWords)];
  const parts = uniqueWords.slice(0, 4);

  if (parts.length === 0) {
    return "coding-session";
  }

  if (parts.length === 1) {
    return `${parts[0]}-session`;
  }

  return parts.join("-");
}

export function isSessionTitleRequest(messages: MessageLike[]) {
  return detectSessionTitleFormat(messages) !== null;
}

export function buildSessionTitleResponse(
  messages: MessageLike[],
): ProviderChatResponse {
  const format = detectSessionTitleFormat(messages);
  const seed = buildTitleSeed(messages);

  if (format === "name") {
    return {
      mode: "text",
      outputText: JSON.stringify({ name: toSessionName(seed) }),
      finishReason: "stop",
    };
  }

  const title = toSessionTitle(seed);

  return {
    mode: "text",
    outputText: JSON.stringify({ title }),
    finishReason: "stop",
  };
}
