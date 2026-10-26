# Installing claudecommander

**For Claude Code:** a person gave you this repository and asked you to install it ("download this plugin and act upon it"). Follow these steps in order. You run every command yourself. A few steps need the person at the keyboard; they are marked **[human]**. For each one, tell the person exactly what to type and why, then wait for them. Do not skip ahead: later steps depend on earlier ones.

**For people:** you do not have to type any of this. Ask Claude Code to install the plugin, and it will tell you when it needs you. The [README](README.md) explains what claudecommander is.

What you get at the end:

- every Claude Code session on this machine can send messages to colleagues' sessions and read their replies;
- a small background service (the daemon) that hears about new messages for this machine;
- a background Claude Code session, the orchestrator, that answers colleagues for you and asks you before anyone gets access to anything.

claudecommander runs on Linux only for now: the daemon is a systemd user service. macOS is not supported yet.

## Step 1 and 2. You are here

The person asked you to install the plugin, and you are reading this file.

## Step 3. Check the prerequisites

```
uname -s
claude --version
node --version
systemctl --user is-system-running
```

- `uname -s` must print `Linux`.
- Claude Code must be 2.1.292 or later (messaging between sessions needs 2.1.224; installing a plugin with `--marketplace` needs 2.1.292).
- Node must be 22 or later.
- `systemctl --user` must answer (any state such as `running` or `degraded` is fine; an error about the bus means there is no user service manager).

If any of these fails, stop and tell the person what to install or upgrade.

## Step 4. Install the plugin

Run this yourself; it does not ask anything. Install it from the claudecommander repository:

```
claude plugin install claudecommander --marketplace olehsharov/claudecommander-plugin --scope user --json
```

It answers with JSON that has `"outcome":"ok"`. It also adds the marketplace to the person's user settings; the removal steps at the end undo both.

## Step 5. [human] Reload plugins

**[human]** Ask the person to type `/reload-plugins` and press Enter (or restart Claude Code). You cannot do this for them. Say why: Claude Code loads a newly installed plugin only after a reload.

After the reload, the plugin's `claudecommander-setup` skill holds these same steps from here on. You can load it, or keep following this file.

## Find the claudecommander command

The plugin's `bin/` folder is on the Bash PATH in a fresh session. In the session that installed the plugin it may not be. Check:

```
command -v claudecommander
```

If that prints nothing, ask Claude Code where the plugin is installed:

```
claude plugin list --json | node -e 'const rows = JSON.parse(require("fs").readFileSync(0, "utf8")); const row = rows.find(plugin => plugin.id.startsWith("claudecommander@") && plugin.enabled); if (!row) { console.error("claudecommander plugin is not installed or not enabled"); process.exit(1); } console.log((row.readFromFolder ?? row.installPath) + "/bin/claudecommander")'
```

Use the path it prints in place of `claudecommander` in every command below.

## Step 6. [human] Sign in to claudecommander

The sign-in must happen before the daemon is installed. The daemon starts the orchestrator, and a session that is already running when the person signs in does not pick up the sign-in until it is restarted.

Pick one of these two ways:

- **Claude runs the sign-in** (only when the person's browser is on this computer). Run this in the background (it waits until the sign-in is finished), and read its output for the sign-in link:

  ```
  claude mcp login plugin:claudecommander:claudecommander --no-browser
  ```

  **[human]** Show the link and say: "Open this link in a browser on this computer and sign in with your Google work account." When the command ends with `Authenticated with ...`, the sign-in is done.
- **The person signs in.** **[human]** Ask them to type `/mcp`, pick the claudecommander server, and choose to sign in.

If the person works over SSH, or their browser is on another computer, the sign-in sends the browser back to an address on this machine that their browser cannot reach. Use one of these instead: **[human]** ask them to type `/mcp` in this session, pick the claudecommander server and sign in; or **[human]** ask them to run, in the foreground of a terminal on this machine, `claude mcp login plugin:claudecommander:claudecommander --no-browser`, open the link on their computer, and when the browser ends on a page that does not load, paste that page's full address into the terminal. Never run it as a background Bash call when the browser is on another computer.

If the sign-in page says the account is not allowed, stop. The page says who to ask for access.

## Step 7. Check the sign-in in a fresh session

After a sign-in from Bash, this session still has only the claudecommander `authenticate` tools, not the real ones. So check the sign-in in a fresh session, never in this one:

```
CLAUDE_CODE_MCP_STARTUP_WAIT_MS=30000 claude -p --model sonnet --allowedTools=mcp__plugin_claudecommander_claudecommander__whoami "Call the whoami tool and print its JSON result exactly as it came. If you do not have that tool, print MISSING."
```

`CLAUDE_CODE_MCP_STARTUP_WAIT_MS=30000` makes the fresh session wait for the claudecommander tools, which connect a few seconds late. The answer holds the person's `email` and `display_name`. Remember the email: step 11 checks it.

If it prints `MISSING`, run it once more. If it still fails, show the person the `Status:` line of `claude mcp get plugin:claudecommander:claudecommander` and go back to step 6.

### Calling claudecommander tools during setup

Steps 11 and 12 call claudecommander tools. Look at your tool list:

- If it has the real tools (for example `mcp__plugin_claudecommander_claudecommander__approve_machine_pairing`), call them directly.
- If it has only `mcp__plugin_claudecommander_claudecommander__authenticate`, make each call in a fresh session, the same way as the `whoami` check, allowing exactly the tools that call needs. For example:

  ```
  CLAUDE_CODE_MCP_STARTUP_WAIT_MS=30000 claude -p --model sonnet --allowedTools=mcp__plugin_claudecommander_claudecommander__approve_machine_pairing "Call approve_machine_pairing with user_code <code> and machine_name <name>, then print its JSON result exactly as it came."
  ```

## Step 8. [human] Choose the projects root

**[human]** Ask: "Which folder holds your projects? Usually it is one folder, such as ~/dev. Your orchestrator will work from there." Turn the answer into an absolute path (for example `/home/alice/dev`) and check the folder exists. This is the projects root.

## Step 9. [human, only if needed] Trust the projects root

The orchestrator runs in the projects root. If Claude Code has never been told to trust that folder, the orchestrator cannot start and fails with `Workspace not trusted`. Check, read-only:

```
node -e 'const configFolder = process.env.CLAUDE_CONFIG_DIR || require("os").homedir(); const config = JSON.parse(require("fs").readFileSync(configFolder + "/.claude.json", "utf8")); console.log(config.projects?.[process.argv[1]]?.hasTrustDialogAccepted === true ? "trusted" : "not trusted")' "<projects root>"
```

If it prints `not trusted`: **[human]** ask the person to open a terminal, run `cd <projects root>` and then `claude`, answer yes to the question about trusting the folder, and then type `/exit`.

## Step 10. [human, only if needed] Let the doorbell through

When a message arrives, the daemon rings the orchestrator's doorbell with a cross-session message from another session. If the `crossSessionInbound` setting is not `accept`, those rings can be held for approval, and messages then wait until someone notices.

Read the setting from the settings files (read only; there is no Claude Code command that prints it):

1. `/etc/claude-code/managed-settings.json`: if it sets `crossSessionInbound`, that value wins and only an admin can change it.
2. `<projects root>/.claude/settings.local.json` and `<projects root>/.claude/settings.json`: only the value `refuse` counts here.
3. `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set).

If the effective value is `accept`, go on. Otherwise explain why it matters, then ask: "May I set crossSessionInbound to accept in your user settings, ~/.claude/settings.json?" Never change it without a clear yes. On a yes, add `"crossSessionInbound": "accept"` to that file and keep everything else in it as it was. The person can also set it themselves in `/config` ("Messages from your other sessions"). If the managed settings decide it, tell the person to ask their admin.

Also look at `permissions.defaultMode` in the same files. The doorbell runs in that mode and the orchestrator runs in `default`. If the effective mode is `bypassPermissions`, the orchestrator holds the doorbell's rings. Tell the person, and ask before changing anything.

## Step 11. Install the daemon and pair this machine

### 11a. Install the daemon

```
claudecommander daemon install --projects-root <projects root>
```

This writes the systemd user service `claudecommander.service` in `~/.config/systemd/user`, copies the daemon to `~/.local/share/claudecommander/daemon`, and starts it. The service may start before the machine is paired; it waits for the pairing.

The defaults are an orchestrator named `orchestrator` running the `sonnet` model. `--orchestrator-name <name>` and `--model <model>` change them.

If install refuses because a `claudecommander.service` it did not write already exists (often an older claudecommander), tell the person, and ask before replacing it. Only on a yes, run the same command again with `--replace` at the end.

### 11b. Pair this machine

Run this in the background, because it waits until the pairing is approved:

```
claudecommander daemon pair
```

1. It prints one line such as `Pairing code: WXYZ-1234 (approve with approve_machine_pairing; expires in 5 minutes)`.
2. Get the machine name with `hostname`.
3. Call `approve_machine_pairing` with `user_code` set to the code and `machine_name` set to that name. It answers with a `machine_id`.
4. The pair command then prints `Paired as machine <machine_id> for <email>` and ends.
5. Compare the two: the `machine_id` from `approve_machine_pairing` must be the one in the `Paired as machine` line, and the email must be the person's own (from step 7).

If they do not match (a mismatch), the code you approved belonged to another daemon. Tell the person first. Then call `revoke_machine` with the `machine_id` you approved, and pair again with a new `claudecommander daemon pair`.

If the pair command says this machine is already paired, ask the person before pairing it again. On a yes, run `claudecommander daemon pair --force`, approve the new code the same way, and then run `systemctl --user restart claudecommander` so the running daemon uses the new pairing.

The machine's secret goes straight from the server to the daemon's private file. It never appears in your context.

### 11c. Check the daemon

```
claudecommander daemon doctor
```

Each line says `ok`, `warning` or `failed`, and what to do. Fix what you can and explain the rest to the person. The orchestrator line may say it is not running yet: the daemon starts it within about a minute of the pairing.

## Step 12. Smoke test: a pong round trip

1. Wait until `claudecommander daemon doctor` shows the orchestrator running: run it about every 30 s. If it is not running after 3 minutes, stop here: show the person the output of `claudecommander daemon doctor`.
2. Read this machine's id with `cat "${XDG_CONFIG_HOME:-$HOME/.config}/claudecommander/machine-id"`.
3. Call `send_message` with `to_machine` set to this machine's id, `body` set to `reply pong`, `reply_to_machine_id` set to this machine's id, and `reply_to_session` set to this session's own name (find it with `ListAgents`; if this session has no name, leave `reply_to_session` out). Never set `reply_to_session` to the name of a fresh `claude -p` session: it ends at once, and the reply could not be forwarded to it. Note the `message_id` `send_message` answers.
4. Call `check_inbox` with `after` set to that `message_id` every 10 s, for up to 3 minutes, until a message appears whose envelope has `in-reply-to="<that message_id>"`. `get_message` on it shows `kind: "reply"`. When you call the tools through fresh sessions (see "Calling claudecommander tools during setup"), poll about every 40 s instead, because each fresh session takes about 30 s to start.

The first message after the orchestrator starts can take a minute or two: its claudecommander tools connect late, and the daemon holds the first doorbell until they do.

If the reply arrives, the test passed. If not, it failed: run `claudecommander daemon doctor` and show the person its output.

## Step 13. Tell the person what they now have

Report, in plain words:

- who they are signed in as (the email and name from `whoami`);
- this machine's name and id;
- that the orchestrator is up, and its name;
- how to talk to it: `claude attach orchestrator` (or its name) opens it in any terminal, and leaving it keeps it running; or, from any Claude Code session, "tell my orchestrator to ...";
- how to message a colleague: in any session, ask Claude to send a message to them by name or email;
- what colleagues can do: ask questions and get answers. Any access to their files or sessions needs the person's own yes first;
- what an access request looks like: it shows up as one or more permission prompts in the orchestrator, with the request (who, what access, why) written just above them. In the orchestrator, every tool that reads files, runs commands, searches or starts a subagent asks first, read-only shell commands such as `cat` or `grep` included. The orchestrator waits, and other messages wait behind it, until the person answers the permission prompts with `claude attach orchestrator`.

## Signing in again later

If the claudecommander sign-in ever has to be redone (a re-login), run `claude mcp login plugin:claudecommander:claudecommander --no-browser` again. Then restart the orchestrator so it picks up the new sign-in: find its id with `claude agents --json --all` and run `claude stop <orchestrator id>`. The daemon wakes it again within a minute.

## Good to know about the daemon

- **Linux only.** The daemon is a systemd user service. macOS is not supported yet.
- **Where the service lives.** The unit file is always `~/.config/systemd/user/claudecommander.service`, because that is where systemd looks for user services. Setting `XDG_CONFIG_HOME` does not move the unit. When `XDG_CONFIG_HOME`, `XDG_STATE_HOME` or `XDG_DATA_HOME` are set in the shell that runs install, install copies them into the unit, so the service finds the same files the shell does.
- **Node version.** The unit runs the exact Node program that ran install. If you use nvm and later remove that Node version, the service stops working until you run `claudecommander daemon install --projects-root <projects root>` again.
- **Plugin updates.** The service runs its own copy of the daemon. After the plugin updates, run `claudecommander daemon install --projects-root <projects root>` again to refresh the copy.
- **An existing service.** If a `claudecommander.service` that this plugin did not write already exists, install refuses until you add `--replace`.
- **Pairing again.** After `claudecommander daemon pair --force`, or after re-pairing a machine that was revoked, run `systemctl --user restart claudecommander`.
- **The plugin's commands.** After installing the plugin, a person types `/reload-plugins`. The `claudecommander` command is then on the Bash PATH in a fresh session.

## When something is wrong

Run `claudecommander daemon doctor` first. It only looks; it changes nothing. Each line says `ok`, `warning` or `failed`, and what to do. Its main checks:

- **cross-session inbound** and **doorbell permission mode**: the doorbell is a message from another session. If `crossSessionInbound` is not `accept`, or the doorbell and the orchestrator run in different permission mode classes (one bypasses prompts, the other asks), the orchestrator holds the rings, and a held ring still looks sent. Messages then wait.
- **daemon loop**: the daemon writes a status file every minute. Doctor reads `loop_running` from it and checks the file is fresh (written in the last two minutes). A stale file means the daemon is stopped or stuck: `systemctl --user restart claudecommander`.
- **doorbell ledger**: the daemon remembers which messages it already rang for in `rung.json`. If that file is corrupt, doctor says so.
- It also checks the backend, the machine's pairing, the service unit, the orchestrator, the Claude Code sign-in, the claudecommander server sign-in, and the Claude Code and Node versions.

## Removing claudecommander

Run these in order:

```
claudecommander daemon uninstall
claude plugin uninstall claudecommander@claudecommander --scope user
claude plugin marketplace remove claudecommander
```

The first stops and removes the service. The second removes the plugin, and the third removes the marketplace that the install added.

## Removing someone

Offboarding a person means two things: remove them from the allowlist, AND revoke their machines (`revoke_machine`). A daemon keeps refreshing its own session with the server directly, so until its machine is revoked it keeps reading its own inbox notices (message ids only, never message text) and publishing its session list, even after its person left the allowlist.

`revoke_machine` works only on your own machines. So ask the person to revoke theirs first (in any Claude Code session: `list_my_machines`, then `revoke_machine` for each), and then remove them from the allowlist. If they cannot, the backend admin has to revoke their machines on the server.
