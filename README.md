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
