---
name: stubs
description: Pull secrets from a Stubs link into a project without ever seeing the values. Use only when the user shares a link on stubs.talix.app (https://stubs.talix.app/t#v1.… or #v2.…) or explicitly refers to Stubs, stubs.talix.app, or @talix/stubs. Not for test stubs, mocks, or fixtures.
---

# Stubs

A Stubs link is a one-time capability: whoever opens it first gets the values, then it's void.
The `@talix/stubs` CLI opens it on this machine and writes the values straight into the
project's env file. It prints key names only, so the values never enter your context, your
transcript, or your logs. That guarantee only holds if you go through the CLI, so follow these
rules exactly.

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
npx -y @talix/stubs@{{VERSION}} pull '<link>' --json
```

- Add `--to <file>` only if the user names a different env file (the default is `.env.local`).
- Run it **once**. The stub is used up the moment it opens; a second run reports it void.
- Use the pinned version above exactly. Don't drop the `@{{VERSION}}`, and don't substitute
  `@latest`.

Then tell the user which keys were written (`written`), which were already set and skipped
(`skipped`, kept as comments in the file), and pass on any `warnings`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Report the key names. |
| 1 | Something else went wrong | If the output has `recoveredFile`, the stub was used and its values were saved there: give the user that path and tell them to move the values themselves; don't open it. Otherwise pass on the message, which says whether the stub was used. Don't retry without asking. |
| 2 | Void: already opened or expired | Ask the user for a new link. Don't retry. |
| 3 | Bad link, wrong site, or a locked stub this machine can't open | Report the message. For a locked stub, the user needs the stubs id of the machine the sender locked it to: `npx -y @talix/stubs@{{VERSION}} id` prints it, or `init` creates one the first time. Don't run either yourself. |
| 4 | Network problem; nothing was used | Retry once. |
| 5 | Refused: git would track the env file (or the file it links to), or git couldn't be asked | Pass on the message: it names the path to add to `.gitignore`, or says git couldn't run. Don't pass `--allow-tracked` unless the user asks. |
| 6 | Opened but wouldn't decrypt; now void | Ask for a new link. |
| 7 | Connection dropped mid-open | Retry once: it either succeeds or reports void. |

## Never

- Never `cat`, read, open, grep, diff, or print the file the values were written to: `.env*`
  files, whatever `--to` named, and any file it links to. That holds before and after pulling.
  Also never read the stubs config folder (`~/.config/stubs/`, or `$XDG_CONFIG_HOME/stubs/`),
  which holds the machine identity and recovered values. If you need to know whether a key is
  set, the pull output already says so.
- Never open the link in a browser, fetch it, or try to decrypt it yourself. The page holds no
  values, and anything you decrypt would land in your transcript.
- Never paste the link into another tool, search, file, or commit. Treat it like the secret
  itself until it's pulled.
- Never echo the values back to the user, even if they ask you to "show" them. Tell them to
  open the file themselves.

## Sending secrets (only when the user asks)

To make a link from a file the user names:

```bash
npx -y @talix/stubs@{{VERSION}} push <file> --ttl 1h --json
```

Add `--to <stubs id>` to lock it to the recipient's machine, which makes the link safe to send
through chat. The output is the link; give it to the user and don't keep copies of it.
