# dsh-plugin-quote-reply

Quote a passage of an assistant reply in DeepSeek Harness and ask about it. Each note carries the
exact place it came from: message id, turn, block, section heading, character range or code lines.

Forked from [mar1259/dsh-plugin-codex-annotate](https://github.com/mar1259/dsh-plugin-codex-annotate)
(MIT). This fork drops the right-click menu for a button at the selection, fixes contrast in the
dark theme, keeps staged notes above the composer as chips, and allows editing a note.

## What it does

- **Button at the selection** — selecting text inside an assistant reply shows a small `Reply here`
  button just above it. Right-click menus are untouched.
- **Exact anchor** — every note records the message id, turn, block index, section heading and
  character range; code blocks record the language and line numbers.
- **Notes as chips** — a confirmed note becomes a chip above the composer, as wide as the composer
  field. The chip shows a short quote and your note; clicking it opens an editor popover.
- **One message** — `Send N notes` joins every staged note into a single message. `Clear` drops them
  all, `×` on a chip drops one.
- **Local only** — no network calls and no telemetry. The plugin only reads the page and fills the
  composer.

## Requirements

DeepSeek Harness 0.2.1-rc.5. There is no build step: `client.js` is the module the client loads.

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

Restart DeepSeek Harness after installing: the client bundle is read at start.

## Use

1. Select text in an assistant reply and press `Reply here` above it.
2. Write the note in the panel. Enter adds it, Shift+Enter starts a new line, Esc discards it.
3. Repeat for other passages. Each note becomes a chip above the composer.
4. Click a chip to edit it, `×` to remove it, then `Send N notes`.

The message you send looks like this:

```text
Quoted reply · Assistant message #1a584033 · turn 2 · paragraph 5 · chars 0–30
│ Остаётся ровно одно: ветка STG-1462

Your note goes here.
```

Code selections arrive fenced and keep their language:

````text
Quoted reply · Assistant message #1a584033 · turn 2 · code block js · lines 1–3
```js
const a = 1
```
````

## Limits

The plugin reads the DOM and React internals: the fiber chain above the selected text and the
`data-chat-flow-kind` attribute. A DeepSeek Harness upgrade can break it, and the fix is to adapt
these two lookups.

- Only assistant replies can be quoted; selections inside the composer are ignored.
- Quotes longer than 300 characters and code longer than 12 lines are cut and marked
  `(truncated)`.
- Staged notes live in memory: reloading the page loses them.

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
