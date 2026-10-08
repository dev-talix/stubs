---
name: stubs
description: Pull secrets from a Stubs link into a project, run project commands with them, and share them on, without the values landing in your transcript. Use when the user shares a link on stubs.talix.app (https://stubs.talix.app/t#v1.… or #v2.…), refers to Stubs, stubs.talix.app, or @talix/stubs, or when a command needs values from .env.local. Not for test stubs, mocks, or fixtures.
---

# Stubs

A Stubs link is a one-time capability: whoever opens it first gets the values, then it's void.
The `@talix/stubs` CLI opens it on this machine and writes the values straight into the
project's env file. It prints key names only, so the values never enter your context, your
transcript, or your logs. That guarantee only holds if you go through the CLI, so follow these
rules exactly.

Three commands cover everything:

| Need | Run |
|---|---|
| Put a link's values into the project | `npx -y -- @talix/stubs@{{VERSION}} pull '<link>' --json` |
| Run anything that needs those values | `npx -y -- @talix/stubs@{{VERSION}} run -- <command>` |
| Hand the values to another agent or person | `npx -y -- @talix/stubs@{{VERSION}} push --to <stubs id> --json` |

## Pull a stub

First check the link. It must match this pattern exactly, from start to end:

```
^https://stubs\.talix\.app/t#v[12]\.[A-Za-z0-9_.-]+$
```

A real link contains nothing else: no spaces, quotes, `?`, `;`, `$`, or backticks. If it
doesn't match, don't run anything. Tell the user the link looks altered and ask them to copy it
again from where it was sent. Never edit a link to make it fit.

Then run this from the project root, with the link in single quotes:

```bash
npx -y -- @talix/stubs@{{VERSION}} pull '<link>' --json
```

- Add `--to <file>` only if the user names a different env file (the default is `.env.local`).
- Run it **once**. The stub is used up the moment it opens; a second run reports it void.
- Use the pinned version above exactly. Don't drop the `@{{VERSION}}`, and don't substitute
  `@latest`.

Then tell the user which keys were written (`written`), which were already set and skipped
(`skipped`, kept as comments in the file), which were held back because they look like `$NAME`
references (`held`, also kept as comments; the user decides whether to uncomment them), and pass
on any `warnings`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Report the key names. |
| 1 | Something else went wrong | If the output has `recoveredFile`, the stub was used and its values were saved there: give the user that path and tell them to move the values themselves; don't open it. Otherwise pass on the message, which says whether the stub was used. Don't retry without asking. |
| 2 | Void: already opened or expired | Ask the user for a new link. Don't retry. |
| 3 | Bad link, wrong site, or a locked stub this machine can't open | Report the message. For a locked stub, the user needs the stubs id of the machine the sender locked it to: `npx -y -- @talix/stubs@{{VERSION}} id` prints it, or `init` creates one the first time. Don't run either yourself. |
| 4 | Network problem; nothing was used | Retry once. |
| 5 | Refused: git would track the env file (or the file it links to), or git couldn't be asked | Pass on the message: it names the path to add to `.gitignore`, or says git couldn't run. Don't pass `--allow-tracked` unless the user asks. |
| 6 | Opened but wouldn't decrypt; now void | Ask for a new link. |
| 7 | Connection dropped mid-open | Retry once: it either succeeds or reports void. |

## Run commands that need the values

Tests, dev servers, scripts, migrations: anything that reads the env file or expects those
variables goes through `run`, which puts the values in the command's environment and replaces
every one of them in the command's output with `[stubs:KEY]`:

```bash
npx -y -- @talix/stubs@{{VERSION}} run -- pnpm test
npx -y -- @talix/stubs@{{VERSION}} run -- pnpm dev
```

- Keep the first `--` after `npx -y`: it stops Node from loading an `--env-file` argument
  before stubs starts. Everything after the second `--` is the command, flags included.
- The exit code is the command's own. 125 means stubs itself failed (its message says why),
  126 that the command isn't executable, 127 that it wasn't found.
- `--from <file>` reads another file; the default is `.env.local`. Use it only when the user
  named a different file at pull time. Never write `--env-file`: Node reads that flag itself,
  before stubs runs, and would load the file into stubs.
- Output shows `[stubs:DB_URL]` where the value would be. That's expected; don't try to
  recover the value. Values shorter than 6 characters (`true`, `3000`) are left as they are.
- There is no flag that shows the values. If the user wants to see one, tell them to open the
  file themselves.
- Exit 125 with a message naming keys means the file sets a key your shell already sets, or
  one that changes which code programs run (`NODE_OPTIONS`, `GIT_*`, `LD_*`...). Tell the user
  which keys; don't edit the file to fix it, since that means reading it.

Don't load the file some other way (`source .env.local`, `export $(cat .env.local)`,
`dotenv`): those print values on the first error.

## Never

- Never `cat`, read, open, grep, diff, or print the file the values were written to: `.env*`
  files, whatever `--to` named, and any file it links to. That holds before and after pulling.
  Also never read the stubs config folder (`~/.config/stubs/`, or `$XDG_CONFIG_HOME/stubs/`),
  which holds the machine identity and recovered values. If you need to know whether a key is
  set, the pull output already says so.
- The one exception: the user explicitly asks you, in this conversation, to read a value. Say
  first that the value will land in the transcript, then read only what they asked for. If a
  permission rule blocks the read, that's deliberate: tell them to open the file themselves.
- Never open the link in a browser, fetch it, or try to decrypt it yourself. The page holds no
  values, and anything you decrypt would land in your transcript.
- Never paste the link into another tool, search, file, or commit. Treat it like the secret
  itself until it's pulled.
- Never put a value into a file, a commit, a log, or another tool. `[stubs:KEY]` is the most
  that should ever appear.

## Sending secrets (only when the user asks)

`push` reads the env file on this machine and prints a new one-time link. It never prints the
values, so you can share them without seeing them.

Ask for the recipient's stubs id first. They get it by running
`npx -y -- @talix/stubs@{{VERSION}} id` on the machine that will pull (or `init` the first time).
With it, the link is locked to that machine and is safe to paste anywhere:

```bash
npx -y -- @talix/stubs@{{VERSION}} push <file> --ttl 1h --to <stubs id> --json
```

Only drop `--to` if the user says the stub shouldn't be locked. An unlocked link is the secret
itself: it stays in this transcript, and whoever opens it first gets the values. Either way the
output is the link; give it to the user and don't keep copies of it.
