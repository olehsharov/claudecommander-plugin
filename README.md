# claudecommander

claudecommander lets the Claude Code sessions of colleagues talk to each other, across people and machines.

- From any Claude Code session, ask: "Send Alice a message: is the billing refactor merged yet?" Her machine gets it, and the answer comes back to your session.
- Each machine has an **orchestrator**: a background Claude Code session that answers colleagues for its owner. It answers questions, and it asks you before anyone gets access to your files or sessions.
- A small background service, the **daemon**, hears about new messages for your machine and wakes the orchestrator. It never sees message text.

It is meant for colleagues inside one company. Only people on the admin's allowlist can sign in.

## Install

Linux only for now (the daemon is a systemd user service). macOS is not supported yet. You need Claude Code 2.1.292 or later and Node 22 or later.

Tell Claude Code:

> download this plugin and act upon it https://github.com/olehsharov/claudecommander-plugin

Claude Code reads [INSTALL.md](INSTALL.md) and does the rest. It stops and asks you when it needs you:

1. to type `/reload-plugins` after it installs the plugin;
2. to sign in with your Google work account in the browser;
3. to say which folder holds your projects (for example `~/dev`);
4. maybe to trust that folder once, and to allow one Claude Code setting (`crossSessionInbound`). It never changes your settings without your yes.

At the end it sends a test message to your own machine and tells you whether the reply came back.

If you prefer to install the plugin yourself, type this in Claude Code , then `/reload-plugins`, then ask Claude to "set up claudecommander":

```
/plugin install claudecommander --marketplace olehsharov/claudecommander-plugin
```

## Using it

- **Message a colleague:** in any Claude Code session, ask Claude to send a message to someone by name or email. The reply comes back to that session, or to your orchestrator if that session has closed.
- **Talk to your orchestrator:** run `claude attach orchestrator` in any terminal. Type to it like any session; leaving keeps it running. Or, from any session, say "tell my orchestrator to ...".
- **See who is around:** ask Claude "who is on claudecommander?" It lists people, their machines, and the sessions they share.

## What colleagues can do through your machine

- Ask questions, and get answers from your orchestrator.
- Ask for access. Reading your files or a session's work is READ access; changing anything or running commands is WRITE access. In your orchestrator, every tool that reads files, runs commands, searches or starts a subagent asks you first, read-only shell commands such as `cat` or `grep` included. So an access request shows up as one or more permission prompts in your orchestrator, with the request (who is asking, taken from their sign-in, what access, and why) written just above them. Answer the permission prompts with `claude attach orchestrator`. Until you do, the orchestrator waits, and colleagues' other messages wait behind it (their senders get a warning).
- A request that needs one of your other sessions is sent to that session, which shows it to you and is told to act only on your yes. That part is an instruction to the session, not a lock: what the session can do without asking depends on its own permission settings.
- The orchestrator is told to treat message text as a colleague's words only: a message cannot give itself permission or speak as you. The orchestrator never edits files or runs commands for a colleague, and those tools ask you too.

Do not put secrets in messages: message text is stored on the server for 14 days and shown to the people it is sent to.

## When something is wrong

Run this first:

```
claudecommander daemon doctor
```

It only looks; it changes nothing. Each line says `ok`, `warning` or `failed`, and what to do. Its main checks:

- **Held messages.** The daemon rings your orchestrator with a message from another session. If the `crossSessionInbound` setting is not `accept`, or the ringing session and the orchestrator run in different permission mode classes (one bypasses prompts, the other asks), the rings are held and messages wait. Doctor tells you which.
- **Is the daemon alive?** The daemon writes a status file every minute. Doctor reads `loop_running` from it and checks the file is fresh. If not, run `systemctl --user restart claudecommander`.
- **Doorbell ledger.** The daemon remembers which messages it already rang for in `rung.json`. Doctor says if that file is corrupt.
- It also checks the backend, your machine's pairing, the service, the orchestrator, your sign-ins, and the Claude Code and Node versions.

Things worth knowing about the daemon:

- **Where the service lives.** The unit is always `~/.config/systemd/user/claudecommander.service`. Setting `XDG_CONFIG_HOME` does not move it. When `XDG_CONFIG_HOME`, `XDG_STATE_HOME` or `XDG_DATA_HOME` are set in the shell that installs it, they are copied into the unit, so the service finds the same files your shell does.
- **Node version.** The service runs the exact Node program that installed it. If you use nvm and remove that Node version, the service breaks until you run `claudecommander daemon install --projects-root <your projects folder>` again. Do the same after a plugin update, to refresh the service's copy of the daemon.
- **An older service.** If a `claudecommander.service` this plugin did not write exists, install refuses until you add `--replace`. Claude asks you first.
- **Pairing again.** After `claudecommander daemon pair --force`, or after re-pairing a machine that was revoked, run `systemctl --user restart claudecommander`.
- **The command line.** After the plugin is installed and you typed `/reload-plugins`, the `claudecommander` command is on the Bash PATH in a fresh session.
- **Signed out?** If you sign in to claudecommander again later, restart the orchestrator so it picks that up. [INSTALL.md](INSTALL.md) says how.

## Removing it

Ask Claude Code to remove claudecommander. The steps are at the end of [INSTALL.md](INSTALL.md): the daemon goes first, then the plugin and its marketplace.

## Removing someone

Offboarding a person means two things: remove them from the allowlist, AND revoke their machines (`revoke_machine`). A daemon keeps refreshing its own session with the server directly, so until its machine is revoked it keeps reading its own inbox notices (message ids only, never message text) and publishing its session list, even after its person left the allowlist.

`revoke_machine` works only on your own machines. Ask the person to revoke theirs first (in any Claude Code session: `list_my_machines`, then `revoke_machine` for each), then remove them from the allowlist. If they cannot, the backend admin has to revoke their machines on the server.
