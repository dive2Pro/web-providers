export function shouldDropToolForProvider(
  provider: string,
  toolName: string | null | undefined,
) {
  if (provider !== "deepseek-web") {
    return false;
  }

  const normalizedToolName = (toolName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  return normalizedToolName === "websearch";
}
