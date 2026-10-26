// Turns a stream of arbitrary-sized chunks into a stream of complete lines.
//
// Copied from acp/src/orchestrator.ts (which keeps its own copy): the plugin
// ships alone and cannot import from the private repository.
//
// A real pipe delivers bytes in whatever chunk sizes the OS feels like, with
// no respect for either line boundaries or UTF-8 character boundaries: a
// multi-byte character (Cyrillic, emoji, anything outside ASCII) can have its
// bytes split across two chunks. Decoding each chunk on its own
// (`chunk.toString()`) corrupts exactly that split character, because the
// trailing partial bytes of one chunk are invalid UTF-8 by themselves.
//
// A StringDecoder fixes this: it holds back any incomplete trailing byte
// sequence from one write() and prepends it to the next, so multi-byte
// characters reassemble no matter where the chunk boundary fell. Splitting
// into lines happens after decoding, on the reassembled string (newline is
// single-byte ASCII either way). Empty lines are skipped.
import { StringDecoder } from 'node:string_decoder';

export function createLineAccumulator(onCompleteLine: (line: string) => void): (chunk: Buffer | string) => void {
  const utf8Decoder = new StringDecoder('utf8');
  let incompleteLineBuffer = '';
  return (chunk: Buffer | string) => {
    const decodedChunk = typeof chunk === 'string' ? chunk : utf8Decoder.write(chunk);
    incompleteLineBuffer += decodedChunk;
    const lines = incompleteLineBuffer.split('\n');
    // The last entry is the start of a line whose newline has not arrived yet
    // (or empty); keep it for the next chunk.
    incompleteLineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        onCompleteLine(line);
      }
    }
  };
}
