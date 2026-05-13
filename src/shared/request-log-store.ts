import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RequestLogEntry } from "./request-logging";

export interface StoredRequestLogEntry extends RequestLogEntry {
  loggedAt: string;
}

export interface RequestLogStore {
  append(entry: RequestLogEntry): Promise<void>;
  list(input?: { limit?: number }): Promise<{
    filePath: string;
    logs: StoredRequestLogEntry[];
  }>;
}

export function getDefaultRequestLogDir(cwd = process.cwd()) {
  return join(cwd, ".web-providers", "request-logs");
}

export class LocalRequestLogStore implements RequestLogStore {
  readonly filePath: string;

  constructor(input: { scope: string; dir?: string }) {
    this.filePath = join(input.dir ?? getDefaultRequestLogDir(), `${input.scope}.ndjson`);
  }

  async append(entry: RequestLogEntry) {
    const record: StoredRequestLogEntry = {
      ...entry,
      loggedAt: new Date().toISOString(),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async list(input?: { limit?: number }) {
    const limit = normalizeLimit(input?.limit);

    try {
      const content = await readFile(this.filePath, "utf8");
      const logs = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => safeParseLogLine(line))
        .filter((entry): entry is StoredRequestLogEntry => entry !== null)
        .slice(-limit)
        .reverse();

      return {
        filePath: this.filePath,
        logs,
      };
    } catch (error) {
      if (isFileMissingError(error)) {
        return {
          filePath: this.filePath,
          logs: [],
        };
      }

      throw error;
    }
  }
}

function normalizeLimit(limit?: number) {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return 100;
  }

  return Math.min(Math.trunc(limit), 1000);
}

function safeParseLogLine(line: string) {
  try {
    return JSON.parse(line) as StoredRequestLogEntry;
  } catch {
    return null;
  }
}

function isFileMissingError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
