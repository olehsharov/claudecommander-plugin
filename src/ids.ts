// Opaque ids: every message, machine, person, conversation and pairing id.
//
// This is the plugin's own copy of the private repository's shared/src/ids.ts.
// The plugin becomes a public repository of its own and must not depend on
// the private one, so it carries the check itself; packaging.test.ts compares
// the two patterns while both live in the same repository.
//
// The daemon puts these ids into the doorbell text it hands the orchestrator,
// so the alphabet is deliberately tiny: letters, digits, underscore and dash.
// None of those can break a line or carry an instruction, and the 64-character
// cap keeps an id from carrying a hidden payload. Ids that start AND end with
// two underscores (__anything__) are refused too: Firestore reserves them as
// document ids and fails the read or write with a server error.
export const OPAQUE_ID_PATTERN = /^(?!__.*__$)[A-Za-z0-9_-]{1,64}$/;

// True only for a string that matches OPAQUE_ID_PATTERN. Accepts unknown so
// callers can check raw input (a Firestore document, a file) without casting.
export function isValidOpaqueId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && OPAQUE_ID_PATTERN.test(candidate);
}
