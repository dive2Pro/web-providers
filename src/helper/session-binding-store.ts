import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersistedSessionBindingSession } from "./types";
import { normalizeBoundModelId } from "./types";

interface PersistedSessionBindingsFile {
  version: number;
  sessions: PersistedSessionBindingSession[];
}

export interface SessionBindingStore {
  load(): Promise<PersistedSessionBindingSession[]>;
  save(input: { sessions: PersistedSessionBindingSession[] }): Promise<void>;
}

export function getDefaultSessionBindingDir(cwd = process.cwd()) {
  return join(cwd, ".web-providers", "session-bindings");
}

export class LocalSessionBindingStore implements SessionBindingStore {
  readonly filePath: string;

  constructor(input: { scope: string; dir?: string }) {
    this.filePath = join(
      input.dir ?? getDefaultSessionBindingDir(),
      `${input.scope}.json`,
    );
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as PersistedSessionBindingsFile;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

      return sessions.map((session) => ({
        sessionId: session.sessionId,
        meta: session.meta,
        bindings: (Array.isArray(session.bindings) ? session.bindings : []).map(
          (binding) => ({
            ...binding,
            modelId: normalizeBoundModelId(binding.provider, binding.modelId),
          }),
        ),
      }));
    } catch (error) {
      if (isFileMissingError(error)) {
        return [];
      }

      throw error;
    }
  }

  async save(input: { sessions: PersistedSessionBindingSession[] }) {
    const payload: PersistedSessionBindingsFile = {
      version: 1,
      sessions: input.sessions.map((session) => ({
        sessionId: session.sessionId,
        meta: session.meta,
        bindings: session.bindings.map((binding) => ({
          ...binding,
          modelId: normalizeBoundModelId(binding.provider, binding.modelId),
        })),
      })),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
