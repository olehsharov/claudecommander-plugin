// Small helpers for turning another program's output, or a thrown error, into
// one line for a log, the status file or doctor's report. Shared by the
// keeper, the doorbell, the daemon loop and doctor so they all cut text the
// same way.

// The first line of `text` that is not blank, trimmed. Output can be long or
// carry anything, so it is cut to `maximumCharacters` when that is given.
export function firstNonEmptyLine(text: string, maximumCharacters: number = Number.POSITIVE_INFINITY): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? 'no error output';
  return line.trim().slice(0, maximumCharacters);
}

// The message of anything thrown. A thrown value need not be an Error, so a
// missing message falls back to the value as text.
export function messageOf(error: unknown): string {
  return (error as Error | null)?.message ?? String(error);
}
