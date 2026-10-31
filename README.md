# Obsidian Provenance w/ Sync

An Obsidian plugin aiming to track who (human or agent) wrote or modified the content in Obsidian and why, backed by a CRDT sync engine to make it possible.

## Why does this project exist?

I've been wanting to work with agents in my Obsidian vault for so long. However, unlike in programming projects, I think keeping track of what content is from AI and what comes from myself matters. This is the original motivation for this project.

Obsidian uses raw Markdown files, which are not so good at holding structured data like which block is written by whom. In the meantime, I actually want better sync behavior since the official sync and the `remotely-save` plugin both make compromises to avoid saving too much metadata or because they don't have a proper backend server. So the CRDT method of syncing kind of solves both of my needs: I can sync with fine-grained control and smarter merging, and it comes with the metadata of "who made this change" if we include it in the first place.

## Architecture Overview

This project has 3 main parts (4 if we want to split server/client):

1. The CRDT backbone (client & server)
   - Traditional CRDT, with author (human, AI) and other customizable metadata (e.g. "why": an agent's observation or direct dictation from a human but inserted by an agent) attached to each change.
   - The ability to infer whom a segment of the final text is attributed to and why from the CRDT records.
2. The Obsidian adaptor
   - Uses the CRDT client to sync
   - Shows the inferred info in the app, with background color decoration for the author (human, agent or mixed) and hover (tentative, more interaction methods to be decided) to show details.
   - Sends the user's input into the editor as CRDT requests with author metadata, etc.
3. The agent interface
   - How AI changes the vault: Edit-like operations with the "why" metadata (enum for now) required.
   - One table of tools (`packages/tools`) behind three surfaces: the `ob-provenance` CLI, a local MCP server (`ob-provenance mcp`), and a remote MCP server inside the sync server.
   - The CLI talks to the running plugin through the official Obsidian CLI, which adds what only Obsidian knows, like links and search. When Obsidian can't answer, it goes to the sync server, which has a limited subset for edits and reads, so long-running agents can work when the computer is down.

The split above is by responsibility. By artifact, we'll have 1 CRDT server (saves the data, serves the remote MCP), 1 Obsidian plugin (which doesn't persist data, only a local cache), and 1 CLI that the plugin installs.

This plugin requires a server, so it may not be in the official plugin list, but I do want to be able to use [BRAT](https://community.obsidian.md/plugins/obsidian42-brat) to install and update it easily.

## Known issue

It's practically impossible to force every change made to the vault to go through our CRDT process, so changes made directly to files should be marked as unknown, and their diffs should also be tracked by CRDT in some way (these changes shouldn't be lost).

## Getting started

### 1. Run the sync server

On a server that has Docker, with a domain pointing at it:

```sh
curl -fsSL https://raw.githubusercontent.com/yy4382/ob-provenance-sync/main/deploy/install.sh | sh -s -- --domain sync.example.com
```

This starts the server and a Caddy proxy that gets an HTTPS certificate automatically. It then prints the server URL, a device token and an agent token. Without `--domain`, the server listens on plain HTTP at port 8787. Running the command again updates the server and keeps its config, which is in `~/provenance-sync/data/config.json`. The image is `ghcr.io/yy4382/ob-provenance-sync-server`.

The config has two kinds of tokens:

- `device` tokens are for Obsidian. Each device you sync gets one.
- `agent` tokens are for agents. Each one may pin an identity, e.g. `"agent": "agent:andy"` for a personal agent. If the identity is left out, the client names itself (`?agent=claude-code`).

### 2. Install the Obsidian plugin

In [BRAT](https://community.obsidian.md/plugins/obsidian42-brat), choose **Add beta plugin** and enter `yy4382/ob-provenance-sync`. In the plugin's settings:

- **Your name**: Text you type is attributed to `human:<name>`.
- **Device name**: Recorded with every change.
- **Server URL**, **Device token**, **Vault ID**: The device token is kept in Obsidian's keychain. The Vault ID must be the same on every device. Leave the server empty to track provenance on one device without syncing.

Sentences are colored by who wrote them:

| Color | Meaning |
| --- | --- |
| green | you typed it |
| teal | your words, inserted by an agent (`human-via-agent`) |
| purple | an agent's own writing |
| orange | mixed: you and an agent both changed this sentence |
| no color | unknown: it came from outside Obsidian (another app, a sync tool, the original files) |

Hover a sentence to see each author, the reason, the agent's note, the time, and the device. On mobile, use the command **Show who wrote the current sentence**.

Two commands change who text is attributed to without changing the text. Both work on the selection, or on the sentence at the cursor when nothing is selected. **Mark selection as written by AI** is for AI output you pasted in: it attributes your text and unknown text to the agent you name, and leaves other agents' text as it is. **Recover provenance of unknown text** changes only unknown text, to you, an agent, or your words inserted by an agent, so nothing an agent wrote can turn into yours.

Edits made to files outside Obsidian are never lost. When the plugin next sees them, they are recorded as `unknown` and merged with everyone else's changes. Don't run another sync tool (Obsidian Sync, remotely-save, iCloud) on the same vault. Their edits would show up as unknown, and they can fight with this plugin.

### 3. Connect agents

**On the computer running Obsidian,** do these in each vault agents should reach. A vault with **Agent CLI** off is invisible to them.

1. In the plugin's settings, turn on **Agent CLI**. It installs `ob-provenance` to `~/.local/bin` and records this vault in `~/.config/ob-provenance`, including the server and device token, in a file only your user can read. It needs Node.js 22.12 or later.
2. In Obsidian's General settings, turn on **Command line interface** and register it, so the `obsidian` command is on your `PATH`. Without it, agents get reading and editing through the server, but not the commands that need Obsidian.

Agents can then run the command, which needs `~/.local/bin` on the `PATH`. `ob-provenance --help` tells an agent everything it needs, and `ob-provenance <command> --help` shows a command's fields and examples:

```sh
ob-provenance --vault Notes read --path today.md
ob-provenance --vault Notes append --path today.md --text "A note." --why agent --agent claude-code
```

Each write has to name its agent, with `--agent <name>` or `OB_PROVENANCE_AGENT`. To use MCP instead, use **Copy Claude Code command** or **Copy MCP JSON config** in the plugin's settings. The copied command starts `ob-provenance mcp`, fixed to this vault. Edits are attributed to the name each MCP client reports in its handshake, so several agents can share one configuration (`--agent <name>` pins a name instead). MCP commands copied before this version no longer work, so copy them again.

`ob-provenance` picks a vault in this order: `--vault <name or id>`, the vault folder it runs in, `OB_PROVENANCE_VAULT`, then your only vault. If that doesn't settle it, the call stops and lists them. It never follows window focus, so a call means the same vault whether or not Obsidian is open. It also stops if it runs inside a vault that has **Agent CLI** off, or if another registered vault can't be read right now, rather than guess.

While Obsidian answers, every operation goes through the plugin. A vault that's registered but closed opens in a new window. When Obsidian can't answer, reads and writes go to the server instead, and `rename`, `delete`, `links`, `backlinks`, `search`, `daily` and `create-daily` fail with the reason. If the server is also unreachable, the agent is told the vault is unavailable. A call the plugin started and never finished, by a timeout or by Obsidian crashing, isn't sent to the server, because the write may already have landed: the agent is told to read the note first. `ob-provenance status` shows which way a call would go.

**Remote, limited mode.** Long-running agents connect to the server over Streamable HTTP at `https://sync.example.com/mcp/<vault-id>`, sending `Authorization: Bearer <agent token>`. Add `?agent=<name>` if the token doesn't pin an identity. Limited mode offers `list_files`, `read_file`, `edit_file`, `append_to_file` and `create_file`.

Every write requires `why`. Use `agent` when the agent wrote the content itself, and `human-via-agent` when the agent is inserting words the human dictated. Writes also accept an optional one-sentence `note`.

## Development

```sh
pnpm install
pnpm build && pnpm lint && pnpm test
pnpm vault:install   # build the plugin into test-vault/ to try it in Obsidian
pnpm e2e             # end-to-end test in a real Obsidian (set OBSIDIAN_BIN off macOS)
pnpm quirks          # check that Obsidian still behaves the way the plugin assumes (MOBILE=1 for the mobile UI)
```

`pnpm e2e` and `pnpm quirks` launch a separate Obsidian instance with its own profile. They work on a temporary vault, so they never open your own vaults. On macOS they run a background-only copy of Obsidian, kept in `~/.cache/ob-provenance-sync` (about 530 MB per Obsidian version), so a run doesn't take focus from what you're doing.

### Obsidian versions

The plugin relies on some behavior Obsidian doesn't document. All of it is in `apps/obsidian/src/quirks.ts`, and each piece has a probe in `apps/obsidian/e2e/quirks.mjs`. One plugin build runs on every device, so it supports every stable Obsidian from `minAppVersion` up.

The [Obsidian compatibility](.github/workflows/obsidian-compat.yml) workflow looks for new stable releases every six hours and tests each supported version on Linux: the quirks on the desktop UI, the quirks on the emulated mobile UI, and `pnpm e2e`. Versions that pass go in `apps/obsidian/e2e/verified-versions.json`. A version that fails gets an issue naming what changed.

These runs use the desktop app, so they don't cover WebKit, the mobile file system or the app being suspended. Nothing here runs on a real phone.

**To add a version**, do nothing: the workflow picks it up. If it fails, keep the old behavior for devices that haven't updated: branch on `requireApiVersion` in the function in `quirks.ts`, and give its probe the same branch with `since`.

**To drop a version**, raise `minAppVersion` in `apps/obsidian/manifest.json`, run `pnpm test`, delete the branches it names, and release. BRAT reads the manifest attached to the release and stops updating devices below `minAppVersion`, so they keep their last working build. A release fails if `minAppVersion` passes the App Store's version.
