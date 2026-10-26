// The names Claude Code gives the claudecommander MCP server and its tools when
// the server comes from this plugin's .mcp.json. Every module that needs one of
// these names imports it from here, and a packaging test checks the server key
// against .mcp.json.
//
// Observed by plan Task 3 question 8 (`claude mcp list` and a session's tool
// list): a plugin server shows up as `plugin:<plugin>:<server>`, and its tools
// as `mcp__plugin_<plugin>_<server>__<tool>`.

// The server's key in plugin/.mcp.json (the file is flat, keyed by server
// name, with no "mcpServers" wrapper; Claude Code loads both shapes).
export const MCP_SERVER_KEY_IN_MCP_JSON = 'claudecommander';

// What `claude mcp list`, `claude mcp get` and `claude mcp login` call the server.
export const PLUGIN_MCP_SERVER_NAME = 'plugin:claudecommander:claudecommander';

// What a session's tool names start with, e.g. `mcp__plugin_claudecommander_claudecommander__get_message`.
export const PLUGIN_MCP_TOOL_PREFIX = 'mcp__plugin_claudecommander_claudecommander__';

// Every tool the claudecommander backend registers (backend/functions/src/mcp/tools).
// playbooks.test.ts checks this list against the backend while plugin/ lives
// in the private repository, and checks every tool name the playbook, the
// skills, INSTALL.md and README.md quote against this list.
export const CLAUDECOMMANDER_MCP_TOOL_NAMES = [
  'whoami',
  'list_machines',
  'list_my_machines',
  'revoke_machine',
  'approve_machine_pairing',
  'send_message',
  'reply',
  'get_message',
  'check_inbox',
  'get_thread',
  'list_unanswered',
] as const;

// Plan Task 2 question 3 (a local-scope server) and Task 3 question 10 (this
// plugin's server): one `claude mcp login` on the machine serves every
// background session started (or restarted) after it. So the setup needs no
// "attach to the orchestrator and run /mcp" step.
export const MCP_LOGIN_SHARED_WITH_BACKGROUND_SESSIONS = true;

// Finds the installed plugin's bin/claudecommander when `command -v
// claudecommander` finds nothing. Claude Code does not export
// CLAUDE_PLUGIN_ROOT to the Bash tool (plan Task 3 question 4), so the setup
// asks `claude plugin list --json` instead. `readFromFolder` is set for a
// local-folder marketplace, `installPath` for a git one; the PATH entry Claude
// Code adds points at the same place. Prints a clear error, and exits 1, when
// no enabled claudecommander plugin exists.
export const BIN_PATH_FALLBACK_LINE = `claude plugin list --json | node -e 'const rows = JSON.parse(require("fs").readFileSync(0, "utf8")); const row = rows.find(plugin => plugin.id.startsWith("claudecommander@") && plugin.enabled); if (!row) { console.error("claudecommander plugin is not installed or not enabled"); process.exit(1); } console.log((row.readFromFolder ?? row.installPath) + "/bin/claudecommander")'`;
