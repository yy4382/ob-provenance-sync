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
3. The MCP server
   - The interface for AI to make changes in the vault, similar to traditional Edit tools but with the "why" metadata (enum for now) required
   - Wraps around the Obsidian CLI? To be determined.
   - Two versions: a local (full) version which has access to Obsidian directly so it can use Obsidian CLI features like viewing links/backlinks, and a remote (limited) subset version that runs on a server (which can, and usually will, run together with the CRDT server) which only has edit / append features for long-running agents like Grok bot to access when the computer is down. (Or we can use obsidian-headless remotely to get the full version.)

The split above is by responsibility. By artifact, we'll have 1 CRDT server (saves the data), 1 Obsidian plugin (which doesn't persist data, only a local cache) and 1 MCP server (checks the Obsidian CLI to determine full/limited mode).

This plugin requires a server, so it may not be in the official plugin list, but I do want to be able to use [BRAT](https://community.obsidian.md/plugins/obsidian42-brat) to install and update it easily.

## Known issue

It's practically impossible to force every change made to the vault to go through our CRDT process, so changes made directly to files should be marked as unknown, and their diffs should also be tracked by CRDT in some way (these changes shouldn't be lost).

## Getting started

### 1. Run the sync server

```sh
cp apps/server/config.example.json config.json   # then replace every token with a long random string
pnpm install && pnpm --filter @provenance/server build
node apps/server/dist/server.js config.json
```

Or use Docker: `docker build -f apps/server/Dockerfile -t provenance-server .`, then run it with a volume holding `config.json` mounted at `/data`. Put it behind a reverse proxy that terminates TLS.

The config has two kinds of tokens:

- `device` tokens are for Obsidian. Each device you sync gets one.
- `agent` tokens are for agents. Each one may pin an identity, e.g. `"agent": "agent:andy"` for a personal agent. If the identity is left out, the client names itself (`?agent=claude-code`).

### 2. Install the Obsidian plugin

Install it with [BRAT](https://community.obsidian.md/plugins/obsidian42-brat) from this repository. In the plugin's settings:

- **Your name**: Text you type is attributed to `human:<name>`.
- **Device name**: Recorded with every change.
- **Server URL**, **Device token**, **Vault ID**: The Vault ID must be the same on every device. Leave the server empty to track provenance on one device without syncing.

Sentences are colored by who wrote them:

| Color | Meaning |
| --- | --- |
| green | you typed it |
| teal | your words, inserted by an agent (`human-via-agent`) |
| purple | an agent's own writing |
| orange | mixed: you and an agent both changed this sentence |
| no color | unknown: it came from outside Obsidian (another app, a sync tool, the original files) |

Hover a sentence to see each author, the reason, the agent's note, the time, and the device. On mobile, use the command **Show who wrote the current sentence**.

Edits made to files outside Obsidian are never lost. When the plugin next sees them, they are recorded as `unknown` and merged with everyone else's changes. Don't run another sync tool (Obsidian Sync, remotely-save, iCloud) on the same vault. Their edits would show up as unknown, and they can fight with this plugin.

### 3. Connect agents (MCP)

**Local, full mode.** On the computer running Obsidian:

```sh
pnpm --filter @provenance/mcp build
claude mcp add obsidian -- node /path/to/repo/packages/mcp/dist/cli.js \
  --vault-path /path/to/vault --agent claude-code \
  --server https://sync.example.com --vault my-vault --token <agent token>
```

While Obsidian runs, edits go through the plugin. Full mode adds `rename_file`, `delete_file`, `get_links`, `get_backlinks` and `search`. When Obsidian is closed, writes go to the server instead. If the server is also unreachable, the agent is told the vault is unavailable.

**Remote, limited mode.** Long-running agents connect to the server over Streamable HTTP at `https://sync.example.com/mcp/<vault-id>`, sending `Authorization: Bearer <agent token>`. Add `?agent=<name>` if the token doesn't pin an identity. Limited mode offers `list_files`, `read_file`, `edit_file`, `append_to_file` and `create_file`.

Every write tool requires `why`. Use `agent` when the agent wrote the content itself, and `human-via-agent` when the agent is inserting words the human dictated. Writes also accept an optional one-sentence `note`.

## Development

```sh
pnpm install
pnpm build && pnpm lint && pnpm test
pnpm vault:install   # build the plugin into test-vault/ to try it in Obsidian
```
