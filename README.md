# dsh-plugin-quote-reply

Quote a passage of an assistant reply in DeepSeek Harness and ask about it. Select text, press the
button that appears next to the selection, write your note, and send every staged note at once. Each
note carries its exact source: message id, turn, block, section heading, character range or code
line numbers.

Forked from [mar1259/dsh-plugin-codex-annotate](https://github.com/mar1259/dsh-plugin-codex-annotate)
(MIT). This fork replaces the right-click menu with a selection button, fixes the button contrast in
the dark theme, and adds note editing.

## What it does

- **Selection button** — selecting text inside an assistant reply shows a small `Reply here` button
  under the selection; the system context menu is left alone.
- **Exact anchors** — message id, turn, block index, section heading and character range; code
  blocks record language and line numbers.
- **Stage, then send** — each confirmation adds a chip above the composer; a chip opens its editor,
  the row keeps `Clear` and `Send N notes`, and everything leaves as one user message.
- **Folded in the bubble** — the sent message collapses the quotes into a `📎 N notes ▾` row that
  expands to the original text.
- **Local only** — no network calls and no telemetry. A note is an ordinary user message, so fork,
  replay, search and context compaction keep working.

## Requirements

DeepSeek Harness 0.2.1-rc.5 (written and tested against the desktop build). There is no build step:
`client.js` is the module the client loads.

## Install

```bash
dsh plugin --profile desktop add github:Grawl/dsh-plugin-quote-reply
```

`desktop` is the desktop app's profile; the web build usually uses `web`. Pin a commit when the app
should not follow the repository:

```bash
dsh plugin --profile desktop add github:Grawl/dsh-plugin-quote-reply#<commit-sha>
```

From a local clone:

```bash
git clone https://github.com/Grawl/dsh-plugin-quote-reply.git
dsh plugin --profile desktop add ./dsh-plugin-quote-reply
```

Restart DeepSeek Harness after installing or updating: the client bundle is read at start.

## Use

1. Select text in an assistant reply.
2. Press `Reply here` under the selection and write the note. Enter saves it, Shift+Enter breaks the
   line, Esc discards it.
3. Repeat for other passages: every note becomes a chip above the composer.
4. Click a chip to edit its text, `×` on the chip removes one note, `Send N notes` sends all of them.

## Compatibility and known limits

The plugin reads DOM and React internals: the fiber chain above the selected text and the
`data-chat-flow-kind` attribute. A DeepSeek Harness upgrade can break it, and the fix is to adapt
these two lookups.

- Selections that span several messages, tool-call cards and streaming replies are ignored.
- Quoted bodies over 300 characters and code over 12 lines are truncated in the message.
- Staged notes live in memory and are cleared when the page reloads.

## Checks

```bash
npm install
npm run check
```

`npm run check` runs oxlint, oxfmt, markdownlint, jscpd and gitleaks; the same command runs in the
GitHub `check` workflow. `npm install` also installs the pre-commit hook (prek) that runs oxlint,
oxfmt, markdownlint and gitleaks on staged files.

## License

MIT. The original copyright notice is kept in [LICENSE](LICENSE).
