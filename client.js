/**
 * Selection quote reply — the browser half of `dsh-plugin-quote-reply`.
 *
 * Select text inside an assistant reply: a small button appears at the selection
 * and opens the quote popover. The popover writes one normal user
 * message that quotes the exact location (message id, turn, block, character
 * range or code lines) together with the selected text, then submits it through
 * the resident composer, so queueing, steering and attachments keep working.
 *
 * The message content stays plain text: no session event type is added, so
 * fork / replay / search see an ordinary user turn.
 *
 * No per-message action row is required. The composer bridge comes from the
 * always-mounted floating seat inside the composer card, and message identity
 * is read from the React fiber chain above the selected text.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-quote-reply',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement

		const NS = 'codex-annotate'
		const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,ul,ol,pre,blockquote,table,figure'

		const DICTS = {
			'zh-CN': {
				replyHere: '在此回答',
				copy: '复制',
				title: '引用回复',
				close: '关闭',
				placeholder: '针对这段内容继续问…',
				hint: 'Enter 添加 · Shift+Enter 换行',
				cancel: '取消',
				send: '发送',
				sending: '发送中…',
				confirm: '确认',
				clear: '清空',
				remove: '移除',
				edit: '编辑',
				annotationOne: '{n} 条注释',
				pendingTitle: '{n} 条注释',
				quoteLabel: '回复引用',
				assistant: '助手消息',
				turn: '第 {n} 轮',
				paragraph: '第 {n} 段',
				paragraphRange: '第 {a}–{b} 段',
				chars: '字符 {a}–{b}',
				codeBlock: '代码块 {lang}',
				code: '文本',
				lines: '第 {a}–{b} 行',
				section: '「{h}」',
				truncated: '（已截断）',
				noteOne: '{n} 条注释',
				noteMany: '{n} 条注释',
				sendOne: '发送',
				sendMany: '发送 {n} 条',
				errorStale: '输入框内容已变化，请重试',
				errorTimeout: '发送超时，请重试',
				errorNoTarget: '暂时无法定位这条回复，请刷新页面后重试',
				errorBusy: '上一条引用还在发送中',
				errorFailed: '发送失败，请重试',
			},
			'en-US': {
				replyHere: 'Reply here',
				copy: 'Copy',
				title: 'Quote reply',
				close: 'Close',
				placeholder: 'Ask about this passage…',
				hint: 'Enter adds · Shift+Enter breaks the line',
				cancel: 'Cancel',
				send: 'Send',
				sending: 'Sending…',
				confirm: 'Confirm',
				clear: 'Clear',
				remove: 'Remove',
				edit: 'Edit',
				annotationOne: '{n} note',
				pendingTitle: '{n} notes',
				quoteLabel: 'Quoted reply',
				assistant: 'Assistant message',
				turn: 'turn {n}',
				paragraph: 'paragraph {n}',
				paragraphRange: 'paragraphs {a}–{b}',
				chars: 'chars {a}–{b}',
				codeBlock: 'code block {lang}',
				code: 'text',
				lines: 'lines {a}–{b}',
				section: '“{h}”',
				truncated: '(truncated)',
				noteOne: '{n} note',
				noteMany: '{n} notes',
				sendOne: 'Send note',
				sendMany: 'Send {n} notes',
				errorStale: 'The composer changed; please try again',
				errorTimeout: 'Sending timed out; please try again',
				errorNoTarget: 'This reply cannot be located right now; refresh and retry',
				errorBusy: 'The previous quote is still sending',
				errorFailed: 'Sending failed; please retry',
			},
		}

		/** sessionId -> composer bridge { sessionId, send }. */
		const composerBridges = new Map()
		/** The single in-flight composer send. */
		const pendingSend = { current: null }

		// ── generic helpers ──────────────────────────────────────────────────────

		function clamp(value, min, max) {
			return Math.min(Math.max(value, min), max)
		}

		function format(template, params) {
			if (params === undefined || params === null) return template
			return template.replace(/\{(\w+)\}/g, (match, key) =>
				params[key] === undefined ? match : String(params[key]),
			)
		}

		function fallbackTranslate(key, params) {
			const template = DICTS['en-US'][key] !== undefined ? DICTS['en-US'][key] : DICTS['zh-CN'][key]
			return format(template !== undefined ? template : key, params)
		}

		/** Two forms are enough here: English singular/plural, Chinese single form. */
		function countLabel(t, n) {
			return t(n === 1 ? 'noteOne' : 'noteMany', { n })
		}

		function makeTranslator(locale) {
			let bound = null
			if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
				try {
					bound = locale.bind(NS)
				} catch {
					bound = null
				}
			}
			return (key, params) => {
				if (bound !== null) {
					try {
						const value = bound(key, params)
						if (typeof value === 'string' && value !== '' && value !== key) return value
					} catch {
						/* fall through to the local dictionary */
					}
				}
				return fallbackTranslate(key, params)
			}
		}

		function shortId(messageId) {
			const text = String(messageId)
			return text.length > 8 ? text.slice(0, 8) : text
		}

		function elementOf(node) {
			if (node === null || node === undefined) return null
			return node.nodeType === 1 ? node : node.parentElement
		}

		function quoteError(code) {
			return { code }
		}

		function selectionRect(range) {
			const rects = range.getClientRects()
			for (let i = rects.length - 1; i >= 0; i -= 1) {
				const rect = rects[i]
				if (rect.width > 0 || rect.height > 0) {
					return {
						top: rect.top,
						left: rect.left,
						width: rect.width,
						height: rect.height,
						bottom: rect.bottom,
					}
				}
			}
			const rect = range.getBoundingClientRect()
			if (rect.width === 0 && rect.height === 0) return null
			return {
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				bottom: rect.bottom,
			}
		}

		// ── React fiber lookup: message identity without CSS class assumptions ───

		function reactFiberOf(element) {
			for (const key of Object.getOwnPropertyNames(element)) {
				if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
					return element[key]
				}
			}
			return null
		}

		/**
		 * Walk the fiber chain above `startEl` for the durable session and message
		 * identity. The rendered assistant node carries `node.data.finalNode`.
		 */
		function fiberContext(startEl) {
			const context = { sessionId: null, messageId: null, turn: null }
			let fiber = reactFiberOf(startEl)
			let hops = 0
			while (fiber !== null && fiber !== undefined && hops < 120) {
				const props = fiber.memoizedProps
				if (props !== null && typeof props === 'object') {
					if (context.sessionId === null && typeof props.sessionId === 'string') {
						context.sessionId = props.sessionId
					}
					const candidate = props.node
					if (candidate !== null && typeof candidate === 'object') {
						const data = candidate.data
						if (
							data !== null &&
							typeof data === 'object' &&
							data.finalNode !== null &&
							data.finalNode !== undefined &&
							typeof data.finalNode.messageId === 'string'
						) {
							context.messageId = data.finalNode.messageId
						} else if (context.messageId === null && typeof candidate.messageId === 'string') {
							context.messageId = candidate.messageId
						}
						if (
							context.turn === null &&
							candidate.location !== null &&
							candidate.location !== undefined
						) {
							const turn = candidate.location.turn
							if (turn !== null && turn !== undefined && typeof turn.turn === 'number')
								context.turn = turn.turn
						}
						if (
							context.turn === null &&
							data !== null &&
							typeof data === 'object' &&
							typeof data.turn === 'number'
						) {
							context.turn = data.turn
						}
					}
					if (context.messageId === null && typeof props.messageId === 'string') {
						context.messageId = props.messageId
					}
				}
				fiber = fiber.return
				hops += 1
			}
			return context
		}

		// ── selection → message location ─────────────────────────────────────────

		function topBlocks(wrapper) {
			const blocks = []
			for (const element of wrapper.querySelectorAll(BLOCK_SELECTOR)) {
				let ancestor = element.parentElement
				let nested = false
				while (ancestor !== null && ancestor !== wrapper) {
					if (ancestor.matches(BLOCK_SELECTOR)) {
						nested = true
						break
					}
					ancestor = ancestor.parentElement
				}
				if (!nested) blocks.push(element)
			}
			return blocks
		}

		function blockIndexOf(blocks, node) {
			for (let i = 0; i < blocks.length; i += 1) {
				if (blocks[i].contains(node)) return i
			}
			return -1
		}

		function headingBefore(wrapper, block) {
			let found = null
			for (const heading of wrapper.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
				const position = block.compareDocumentPosition(heading)
				if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) found = heading.textContent.trim()
			}
			if (found === null) return null
			return found.length > 40 ? found.slice(0, 40) + '…' : found
		}

		function blockKindOf(block) {
			const tag = block.tagName.toLowerCase()
			if (tag === 'pre') return 'code'
			if (
				tag === 'h1' ||
				tag === 'h2' ||
				tag === 'h3' ||
				tag === 'h4' ||
				tag === 'h5' ||
				tag === 'h6'
			)
				return 'heading'
			if (tag === 'ul' || tag === 'ol') return 'list'
			if (tag === 'blockquote') return 'quote'
			if (tag === 'table') return 'table'
			return 'paragraph'
		}

		function codeLanguage(block) {
			const code = block.querySelector('code')
			const className = code !== null && typeof code.className === 'string' ? code.className : ''
			const found = /language-([A-Za-z0-9_+-]+)/.exec(className)
			return found === null ? null : found[1]
		}

		function describeBlock(block, blocks, startIndex, range, text, wrapper) {
			const endIndexRaw = blocks.length === 0 ? -1 : blockIndexOf(blocks, range.endContainer)
			const endIndex = endIndexRaw < 0 ? startIndex : endIndexRaw
			const kind = blockKindOf(block)
			const before = document.createRange()
			before.selectNodeContents(block)
			before.setEnd(range.startContainer, range.startOffset)
			const prefixText = before.toString()
			const startOffset = prefixText.length
			const endOffset = startOffset + text.length
			const lineStart = prefixText.split('\n').length
			const lineEnd = lineStart + text.split('\n').length - 1
			return {
				kind,
				blockIndex: startIndex >= 0 ? startIndex + 1 : null,
				blockIndexEnd: endIndex >= 0 ? endIndex + 1 : null,
				startOffset,
				endOffset,
				lineStart,
				lineEnd,
				lang: kind === 'code' ? codeLanguage(block) : null,
				heading:
					kind === 'heading'
						? block.textContent.trim().slice(0, 40)
						: wrapper === null
							? null
							: headingBefore(wrapper, block),
			}
		}

		function buildLocator(info, t) {
			const parts = [t('assistant')]
			if (info.messageId !== null && info.messageId !== undefined) {
				parts[0] = parts[0] + ' #' + shortId(info.messageId)
			}
			if (info.turn !== null && info.turn !== undefined && info.turn !== '') {
				parts.push(t('turn', { n: info.turn }))
			}
			const block = info.block
			if (block === null) return parts.join(' · ')
			if (block.kind === 'code') {
				parts.push(t('codeBlock', { lang: block.lang !== null ? block.lang : t('code') }))
				parts.push(t('lines', { a: block.lineStart, b: block.lineEnd }))
				return parts.join(' · ')
			}
			if (block.blockIndex !== null) {
				if (block.blockIndexEnd !== null && block.blockIndexEnd > block.blockIndex) {
					parts.push(t('paragraphRange', { a: block.blockIndex, b: block.blockIndexEnd }))
				} else {
					parts.push(t('paragraph', { n: block.blockIndex }))
				}
			}
			if (block.heading) parts.push(t('section', { h: block.heading }))
			parts.push(t('chars', { a: block.startOffset, b: block.endOffset }))
			return parts.join(' · ')
		}

		function pickBridge(sessionId) {
			if (sessionId !== null) {
				const exact = composerBridges.get(sessionId)
				if (exact !== undefined) return exact
			}
			if (composerBridges.size === 1) {
				for (const bridge of composerBridges.values()) return bridge
			}
			return undefined
		}

		/**
		 * Resolve one DOM selection inside a finalized assistant reply.
		 * @returns {{ target: object, rect: object } | null}
		 */
		function readTarget(range, text, t) {
			const startEl = elementOf(range.startContainer)
			if (startEl === null) return null
			if (startEl.closest('[data-codex-ui]') !== null) return null
			if (startEl.closest('input,textarea,[contenteditable="true"],[contenteditable=""]') !== null)
				return null
			const wrapper = startEl.closest('[data-chat-flow-kind]')
			const flowKind = wrapper === null ? null : wrapper.getAttribute('data-chat-flow-kind')
			const inChat = startEl.closest('[data-chat-flow]') !== null
			let context
			try {
				context = fiberContext(startEl)
			} catch {
				context = { sessionId: null, messageId: null, turn: null }
			}
			if (context.messageId === null) {
				if (flowKind !== null && flowKind !== 'assistant-step') return null
				// Unknown build without flow attributes: stay permissive inside the
				// chat column, but never widen past it.
				if (flowKind === null && !inChat) return null
			}
			const bridge = pickBridge(context.sessionId)
			// A missing composer bridge must not hide the menu: the panel reports it
			// when the user tries to send, which is easier to diagnose than silence.
			const blocks = wrapper === null ? [] : topBlocks(wrapper)
			const startIndex = blocks.length === 0 ? -1 : blockIndexOf(blocks, startEl)
			const block = startIndex >= 0 ? blocks[startIndex] : startEl.closest(BLOCK_SELECTOR)
			const info =
				block === null || block === undefined
					? null
					: describeBlock(block, blocks, startIndex, range, text, wrapper)
			let turn = context.turn
			if (turn === null && wrapper !== null) {
				const raw = wrapper.getAttribute('data-chat-turn')
				if (raw !== null && raw !== '') turn = raw
			}
			const locator = buildLocator({ messageId: context.messageId, turn, block: info }, t)
			const rect = selectionRect(range)
			if (rect === null) return null
			const preview = text.length > 160 ? text.slice(0, 160) + '…' : text
			return {
				rect,
				target: {
					bridge,
					messageId: context.messageId,
					sessionId: context.sessionId,
					locator,
					preview,
					quote: text,
					code: info !== null && info.kind === 'code',
					lang: info !== null ? info.lang : null,
				},
			}
		}

		// ── outgoing message ─────────────────────────────────────────────────────

		function longestBacktickRun(text) {
			let longest = 0
			let current = 0
			for (let i = 0; i < text.length; i += 1) {
				if (text[i] === '`') {
					current += 1
					if (current > longest) longest = current
				} else {
					current = 0
				}
			}
			return longest
		}

		function buildMessage(target, reply, t) {
			const lines = ['> **' + t('quoteLabel') + '** · ' + target.locator]
			if (target.code) {
				const fence = '`'.repeat(Math.max(3, longestBacktickRun(target.quote) + 1))
				const codeLines = target.quote.split('\n')
				const kept = codeLines.slice(0, 12)
				lines.push('> ' + fence + (target.lang !== null ? target.lang : ''))
				for (const line of kept) lines.push('> ' + line)
				if (codeLines.length > kept.length) lines.push('> ' + t('truncated'))
				lines.push('> ' + fence)
			} else {
				const clipped = target.quote.length > 300 ? target.quote.slice(0, 300) : target.quote
				for (const line of clipped.split('\n')) lines.push('> ' + line)
				if (clipped.length < target.quote.length) lines.push('> ' + t('truncated'))
			}
			return lines.join('\n') + '\n\n' + reply.trim()
		}

		// ── collapse the rendered quote inside the user bubble ───────────────────
		//
		// The quote stays in the message text (the model must see it), but the
		// bubble shows an attachment-like chip instead. Host markdown renders the
		// quote as a <blockquote>; we tag those blocks and let CSS hide their
		// children until the chip is expanded.

		const QUOTE_LABELS = [DICTS['zh-CN'].quoteLabel, DICTS['en-US'].quoteLabel]

		function isQuoteText(text) {
			for (const label of QUOTE_LABELS) {
				if (text.startsWith(label)) return true
			}
			return false
		}

		function toggleQuoteBlock(block) {
			const open = block.hasAttribute('data-codex-open')
			if (open) block.removeAttribute('data-codex-open')
			else block.setAttribute('data-codex-open', '')
			block.setAttribute('aria-expanded', open ? 'false' : 'true')
		}

		function tagQuoteBlocks(t) {
			const blocks = document.querySelectorAll('blockquote')
			const groups = new Map()
			for (const block of blocks) {
				if (block.closest('[data-codex-ui]') !== null) continue
				// Assistant prose may quote arbitrary text; only tag user bubbles.
				if (block.closest('[data-chat-flow-kind="assistant-step"]') !== null) continue
				const text = (block.textContent === null ? '' : block.textContent).trim()
				if (!isQuoteText(text)) continue
				const root = block.closest('[data-chat-flow-kind]') || block.parentElement
				if (root === null) continue
				let list = groups.get(root)
				if (list === undefined) {
					list = []
					groups.set(root, list)
				}
				list.push(block)
			}
			for (const list of groups.values()) {
				const label = countLabel(t, list.length)
				for (const block of list) {
					if (block.getAttribute('data-codex-label') !== label)
						block.setAttribute('data-codex-label', label)
					if (!block.hasAttribute('data-codex-quote')) {
						block.setAttribute('data-codex-quote', '')
						block.setAttribute('role', 'button')
						block.setAttribute('tabindex', '0')
						block.setAttribute('aria-expanded', 'false')
						const title = (block.textContent === null ? '' : block.textContent)
							.trim()
							.split('\n')[0]
						if (title !== '') block.setAttribute('title', title.slice(0, 160))
					}
				}
			}
		}

		// ── composer bridge ──────────────────────────────────────────────────────

		function settleSend(entry, error) {
			if (entry.done) return
			entry.done = true
			window.clearTimeout(entry.timer)
			if (pendingSend.current === entry) pendingSend.current = null
			if (error !== null) entry.reject(error)
			else entry.resolve('sent')
		}

		function commitSend(entry) {
			if (entry.done || entry.submitting) return
			entry.submitting = true
			try {
				entry.actions.submit()
			} catch {
				settleSend(entry, quoteError('failed'))
				return
			}
			settleSend(entry, null)
		}

		function sendThroughComposer(latest, text) {
			return new Promise((resolve, reject) => {
				const state = latest.current
				const actions = state.inputActions
				if (actions === null || actions === undefined || typeof actions.submit !== 'function') {
					reject(quoteError('no-target'))
					return
				}
				if (pendingSend.current !== null) {
					reject(quoteError('busy'))
					return
				}
				const draft = state.draft
				const prefix = draft.trim() === '' ? '' : '\n\n'
				const expected = draft + prefix + text
				const entry = {
					sessionId: state.sessionId,
					expected,
					resolve,
					reject,
					actions,
					done: false,
					submitting: false,
					readDraft: () => latest.current.draft,
					timer: 0,
				}
				// The editor may commit asynchronously: submit as soon as the draft
				// reflects the composed text, and only fall back to the timer.
				entry.timer = window.setTimeout(() => {
					if (entry.done) return
					if (entry.readDraft() === entry.expected) {
						commitSend(entry)
						return
					}
					settleSend(entry, quoteError('timeout'))
				}, 1500)
				pendingSend.current = entry
				try {
					if (draft.trim() !== '' && typeof actions.insertText === 'function') {
						const span = { start: draft.length, end: draft.length, draftRev: state.rev }
						if (!actions.insertText(prefix + text, span)) {
							settleSend(entry, quoteError('stale'))
						}
					} else if (typeof actions.setDraft === 'function') {
						actions.setDraft(expected)
					} else {
						settleSend(entry, quoteError('no-target'))
					}
				} catch {
					settleSend(entry, quoteError('failed'))
				}
			})
		}

		function ComposerBridge(props) {
			if (typeof props.useInput === 'function') return h(ComposerBridgeLive, props)
			return h(ComposerBridgeFallback, props)
		}

		function ComposerBridgeLive(props) {
			const state = props.useInput((s) => s)
			const latest = React.useRef({
				draft: '',
				rev: 0,
				inputActions: null,
				sessionId: props.sessionId,
			})
			latest.current.draft =
				state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
			latest.current.rev =
				state !== null && state !== undefined && typeof state.draftRev === 'number'
					? state.draftRev
					: 0
			latest.current.inputActions = props.inputActions
			latest.current.sessionId = props.sessionId

			React.useEffect(() => {
				if (typeof props.sessionId !== 'string') return undefined
				const bridge = {
					sessionId: props.sessionId,
					send: (text) => sendThroughComposer(latest, text),
				}
				composerBridges.set(props.sessionId, bridge)
				return () => {
					if (composerBridges.get(props.sessionId) === bridge)
						composerBridges.delete(props.sessionId)
				}
			}, [props.sessionId])

			const draft = latest.current.draft
			React.useEffect(() => {
				const entry = pendingSend.current
				if (entry === null || entry.done || entry.submitting) return
				if (entry.sessionId !== props.sessionId) return
				if (draft !== entry.expected) return
				commitSend(entry)
			}, [draft, props.sessionId])

			return null
		}

		function ComposerBridgeFallback(props) {
			React.useEffect(() => {
				if (typeof props.sessionId !== 'string') return undefined
				const bridge = {
					sessionId: props.sessionId,
					send: (text) =>
						new Promise((resolve, reject) => {
							const actions = props.inputActions
							if (
								actions === null ||
								actions === undefined ||
								typeof actions.setDraft !== 'function' ||
								typeof actions.submit !== 'function'
							) {
								reject(quoteError('no-target'))
								return
							}
							try {
								actions.setDraft(text)
								window.setTimeout(() => {
									try {
										actions.submit()
										resolve('sent')
									} catch {
										reject(quoteError('failed'))
									}
								}, 30)
							} catch {
								reject(quoteError('failed'))
							}
						}),
				}
				composerBridges.set(props.sessionId, bridge)
				return () => {
					if (composerBridges.get(props.sessionId) === bridge)
						composerBridges.delete(props.sessionId)
				}
			}, [props.sessionId, props.inputActions])
			return null
		}

		// ── pending annotations (confirmed, not yet sent) ───────────────────────

		let noteSeq = 0
		const notesStore = { items: [], listeners: new Set() }

		function emitNotes() {
			for (const listener of Array.from(notesStore.listeners)) {
				try {
					listener()
				} catch {
					/* one bad listener must not stop the rest */
				}
			}
		}

		function addNote(note) {
			notesStore.items = [...notesStore.items, note]
			emitNotes()
		}

		function removeNote(id) {
			notesStore.items = notesStore.items.filter((note) => note.id !== id)
			emitNotes()
		}

		function updateNote(id, reply) {
			notesStore.items = notesStore.items.map((note) =>
				note.id === id ? { ...note, reply } : note,
			)
			emitNotes()
		}

		function clearNotes(sessionId) {
			notesStore.items = notesStore.items.filter((note) => note.sessionId !== sessionId)
			emitNotes()
		}

		function useNotes() {
			const [items, setItems] = React.useState(notesStore.items)
			React.useEffect(() => {
				const listener = () => setItems(notesStore.items)
				notesStore.listeners.add(listener)
				listener()
				return () => {
					notesStore.listeners.delete(listener)
				}
			}, [])
			return items
		}

		function noteFailure(t, reason) {
			const code = reason !== null && typeof reason === 'object' ? reason.code : ''
			if (code === 'stale') return t('errorStale')
			if (code === 'timeout') return t('errorTimeout')
			if (code === 'busy') return t('errorBusy')
			if (code === 'no-target') return t('errorNoTarget')
			return t('errorFailed')
		}

		/** Staged notes sit above the composer, like attachments, and stay editable. */
		function NotesTray(props) {
			const t = props.t
			const sessionId = props.sessionId ?? (props.session && props.session.sessionId)
			const notes = useNotes().filter((note) => note.sessionId === sessionId)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			if (notes.length === 0) return null

			const sendAll = () => {
				if (busy) return
				const bridge = pickBridge(sessionId)
				if (bridge === undefined) {
					setError(t('errorNoTarget'))
					return
				}
				const text = notes.map((note) => buildMessage(note, note.reply, t)).join('\n\n')
				setBusy(true)
				setError('')
				bridge.send(text).then(
					() => {
						setBusy(false)
						clearNotes(sessionId)
					},
					(reason) => {
						setBusy(false)
						setError(noteFailure(t, reason))
					},
				)
			}

			return h(
				'div',
				{
					'data-codex-ui': '',
					className: 'codexNotesTray',
					role: 'group',
					'aria-label': countLabel(t, notes.length),
				},
				notes.map((note) =>
					h(
						'div',
						{ key: note.id, className: 'codexNotesItem' },
						h(
							'div',
							{ className: 'codexNotesItemHead' },
							h('span', { className: 'codexNotesItemQuote', title: note.quote }, note.quote),
							h(
								'button',
								{
									type: 'button',
									className: 'codexNotesItemRemove',
									title: t('remove'),
									onClick: () => removeNote(note.id),
								},
								t('remove'),
							),
						),
						h('textarea', {
							className: 'codexNotesItemInput',
							rows: 2,
							value: note.reply,
							'aria-label': t('edit'),
							onChange: (event) => updateNote(note.id, event.target.value),
						}),
						h('div', { className: 'codexNotesItemMeta' }, note.locator),
					),
				),
				error === '' ? null : h('div', { className: 'codexAnnotateError', role: 'alert' }, error),
				h(
					'div',
					{ className: 'codexNotesTrayFoot' },
					h(
						'button',
						{
							type: 'button',
							className: 'codexNotesGhost',
							disabled: busy,
							onClick: () => clearNotes(sessionId),
						},
						t('clear'),
					),
					h(
						'button',
						{
							type: 'button',
							className: 'codexNotesSend',
							disabled: busy || notes.some((note) => note.reply.trim() === ''),
							onClick: sendAll,
						},
						busy
							? t('sending')
							: notes.length === 1
								? t('sendOne')
								: t('sendMany', { n: notes.length }),
					),
				),
			)
		}

		// ── overlay: selection action + quote popover ────────────────────────────

		function quoteGlyph(size) {
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: size === undefined ? 13 : size,
					height: size === undefined ? 13 : size,
					'aria-hidden': true,
					style: { flex: 'none', display: 'block' },
				},
				h('path', {
					d: 'M3 3h4v5H4.6c0 1.9.8 2.9 2.4 3v2C4 13 3 11 3 8V3Zm6 0h4v5H10.6c0 1.9.8 2.9 2.4 3v2c-3 0-4-2-4-5V3Z',
					fill: 'currentColor',
				}),
			)
		}

		function placeAction(rect) {
			const centre = clamp(rect.left + Math.max(rect.width, 36) / 2, 72, window.innerWidth - 72)
			return { top: Math.max(8, rect.top - 40) + 'px', left: centre + 'px' }
		}

		function placePanel(rect) {
			const width = Math.min(360, window.innerWidth - 16)
			const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8))
			const below = window.innerHeight - rect.bottom > 300
			if (below) {
				return {
					top: Math.max(8, rect.bottom + 8) + 'px',
					left: left + 'px',
					width: width + 'px',
				}
			}
			return {
				bottom: Math.max(8, window.innerHeight - rect.top + 8) + 'px',
				left: left + 'px',
				width: width + 'px',
			}
		}

		function Annotator(props) {
			const t = props.t
			const tRef = React.useRef(t)
			tRef.current = t

			const [action, setAction] = React.useState(null)
			const [panel, setPanel] = React.useState(null)
			const [reply, setReply] = React.useState('')
			const [error, setError] = React.useState('')

			const panelRef = React.useRef(null)
			const popRef = React.useRef(null)
			const inputRef = React.useRef(null)
			panelRef.current = panel

			React.useEffect(() => {
				// The action button follows the selection, so quoting needs no right-click.
				// Only a fresh selection opens it: a collapsed selection afterwards must not
				// close it, because the chat re-renders while the pointer is still down.
				const offer = () => {
					if (panelRef.current !== null) return
					const selection = window.getSelection()
					if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return
					const range = selection.getRangeAt(0)
					const text = selection.toString().replace(/\s+$/, '')
					if (text.trim() === '') return
					const resolved = readTarget(range, text, tRef.current)
					if (resolved === null) return
					setAction({ target: resolved.target, rect: resolved.rect })
				}
				let frame = 0
				const schedule = () => {
					if (frame !== 0) return
					frame = window.requestAnimationFrame(() => {
						frame = 0
						offer()
					})
				}
				const onPointerUp = () => window.setTimeout(schedule, 0)
				document.addEventListener('mouseup', onPointerUp, true)
				document.addEventListener('keyup', schedule, true)
				return () => {
					if (frame !== 0) window.cancelAnimationFrame(frame)
					document.removeEventListener('mouseup', onPointerUp, true)
					document.removeEventListener('keyup', schedule, true)
				}
			}, [])

			React.useEffect(() => {
				let frame = 0
				const sync = () => {
					frame = 0
					tagQuoteBlocks(tRef.current)
				}
				const schedule = () => {
					if (frame !== 0) return
					frame = window.requestAnimationFrame(sync)
				}
				const onQuoteClick = (event) => {
					const target = event.target
					if (!(target instanceof Element)) return
					const block = target.closest('blockquote[data-codex-quote]')
					if (block === null || target !== block) return
					const selection = window.getSelection()
					if (selection !== null && !selection.isCollapsed) return
					event.preventDefault()
					event.stopPropagation()
					toggleQuoteBlock(block)
				}
				const onQuoteKey = (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return
					const target = event.target
					if (!(target instanceof Element)) return
					const block = target.closest('blockquote[data-codex-quote]')
					if (block === null || target !== block) return
					event.preventDefault()
					event.stopPropagation()
					toggleQuoteBlock(block)
				}
				sync()
				const observer = new MutationObserver(schedule)
				observer.observe(document.body, { childList: true, subtree: true })
				document.addEventListener('click', onQuoteClick, true)
				document.addEventListener('keydown', onQuoteKey, true)
				return () => {
					observer.disconnect()
					if (frame !== 0) window.cancelAnimationFrame(frame)
					document.removeEventListener('click', onQuoteClick, true)
					document.removeEventListener('keydown', onQuoteKey, true)
				}
			}, [])

			React.useEffect(() => {
				if (action === null && panel === null) return undefined
				const onDown = (event) => {
					const target = event.target
					if (target instanceof Element && target.closest('[data-codex-ui]') !== null) return
					setAction(null)
					if (panel !== null) {
						setPanel(null)
						setReply('')
						setError('')
					}
				}
				document.addEventListener('mousedown', onDown, true)
				return () => document.removeEventListener('mousedown', onDown, true)
			}, [action, panel])

			React.useEffect(() => {
				if (action === null && panel === null) return undefined
				const onKey = (event) => {
					if (event.key !== 'Escape') return
					event.stopPropagation()
					setAction(null)
					setPanel(null)
					setReply('')
					setError('')
				}
				document.addEventListener('keydown', onKey, true)
				return () => document.removeEventListener('keydown', onKey, true)
			}, [action, panel])

			React.useEffect(() => {
				if (action === null) return undefined
				const onScroll = (event) => {
					const target = event.target
					if (target instanceof Element && target.closest('[data-codex-ui]') !== null) return
					if (action !== null) setAction(null)
				}
				window.addEventListener('scroll', onScroll, true)
				window.addEventListener('resize', onScroll)
				return () => {
					window.removeEventListener('scroll', onScroll, true)
					window.removeEventListener('resize', onScroll)
				}
			}, [action])

			React.useEffect(() => {
				if (panel === null) return
				const node = inputRef.current
				if (node === null) return
				node.focus()
				node.setSelectionRange(node.value.length, node.value.length)
			}, [panel])

			const closePanel = () => {
				setPanel(null)
				setReply('')
				setError('')
			}

			const openPanel = () => {
				if (action === null) return
				const target = action.target
				const rect = action.rect
				setAction(null)
				setPanel({ target, rect })
				setReply('')
				setError('')
			}

			const confirm = () => {
				if (panel === null) return
				const value = reply.trim()
				if (value === '') return
				const bridge = pickBridge(panel.target.sessionId)
				const sessionId =
					panel.target.sessionId !== null
						? panel.target.sessionId
						: bridge === undefined
							? null
							: bridge.sessionId
				noteSeq += 1
				addNote({
					id: 'note-' + String(noteSeq),
					sessionId,
					locator: panel.target.locator,
					quote: panel.target.quote,
					code: panel.target.code,
					lang: panel.target.lang,
					reply: value,
				})
				closePanel()
				const selection = window.getSelection()
				if (selection !== null) selection.removeAllRanges()
			}

			const onKeyDown = (event) => {
				if (event.key === 'Escape') {
					event.preventDefault()
					closePanel()
					return
				}
				if (event.key !== 'Enter') return
				if (event.shiftKey || event.isComposing || event.nativeEvent.isComposing) return
				event.preventDefault()
				confirm()
			}

			const autoGrow = (event) => {
				const node = event.currentTarget
				node.style.height = 'auto'
				node.style.height = Math.min(node.scrollHeight, 180) + 'px'
			}

			const actionNode =
				action === null
					? null
					: h(
							'button',
							{
								type: 'button',
								'data-codex-ui': '',
								className: 'codexQuoteAction',
								style: placeAction(action.rect),
								// Keeping the selection alive is what makes the click land on the button.
								onMouseDown: (event) => event.preventDefault(),
								onClick: openPanel,
							},
							h('span', { className: 'codexQuoteActionIcon' }, quoteGlyph(12)),
							t('replyHere'),
						)

			const panelNode =
				panel === null
					? null
					: h(
							'div',
							{
								ref: popRef,
								'data-codex-ui': '',
								className: 'codexAnnotatePanel',
								role: 'dialog',
								'aria-label': t('title'),
								style: placePanel(panel.rect),
							},
							h(
								'div',
								{ className: 'codexAnnotateHead' },
								h('span', { className: 'codexAnnotateTitle' }, t('title')),
								h(
									'button',
									{
										type: 'button',
										className: 'codexAnnotateClose',
										'aria-label': t('close'),
										title: t('close'),
										onClick: closePanel,
									},
									'×',
								),
							),
							h('div', { className: 'codexAnnotateLocator' }, panel.target.locator),
							h('div', { className: 'codexAnnotateQuote' }, panel.target.preview),
							h('textarea', {
								ref: inputRef,
								className: 'codexAnnotateInput',
								rows: 3,
								value: reply,
								placeholder: t('placeholder'),
								'aria-label': t('placeholder'),
								onChange: (event) => setReply(event.target.value),
								onKeyDown,
								onInput: autoGrow,
							}),
							error === ''
								? null
								: h('div', { className: 'codexAnnotateError', role: 'alert' }, error),
							h(
								'div',
								{ className: 'codexAnnotateFoot' },
								h('span', { className: 'codexAnnotateHint' }, t('hint')),
								h(
									'div',
									{ className: 'codexAnnotateActions' },
									h(
										'button',
										{
											type: 'button',
											className: 'codexAnnotateBtn',
											onClick: closePanel,
										},
										t('cancel'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'codexAnnotateBtn codexAnnotatePrimary',
											disabled: reply.trim() === '',
											onClick: confirm,
										},
										t('confirm'),
									),
								),
							),
						)

			return h(React.Fragment, null, actionNode, panelNode)
		}

		// ── styles ───────────────────────────────────────────────────────────────

		const CSS = `
.codexQuoteAction{
  position:fixed; z-index:74; transform:translateX(-50%); box-sizing:border-box;
  display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 12px;
  border:0; border-radius:8px; cursor:pointer; font:inherit; font-size:12.5px; font-weight:600;
  background:#2f6feb; color:#fff; box-shadow:0 8px 24px rgba(0,0,0,.28);
}
.codexQuoteAction:hover{background:#3b7bf2}
.codexQuoteActionIcon{display:inline-flex; align-items:center}
.codexAnnotatePanel{
  position:fixed; z-index:71; box-sizing:border-box; max-height:70vh; overflow:auto;
  pointer-events:auto;
  padding:12px; border-radius:12px; font-size:13px; line-height:1.5;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1); box-shadow:0 18px 48px rgba(0,0,0,.24);
}
.codexAnnotateHead{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px}
.codexAnnotateTitle{font-weight:600; font-size:13px}
.codexAnnotateClose{
  width:22px; height:22px; border:0; border-radius:6px; cursor:pointer; padding:0;
  background:transparent; color:var(--dsw-alias-label-secondary); font-size:15px; line-height:1;
}
.codexAnnotateClose:hover{background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary)}
.codexAnnotateLocator{font-size:11px; line-height:1.4; color:var(--dsw-alias-label-secondary); margin-bottom:6px}
.codexAnnotateQuote{
  margin:0 0 10px; padding:8px 10px; border-radius:8px; max-height:72px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
  border-left:3px solid var(--dsw-alias-border-l2);
}
.codexAnnotateInput{
  display:block; width:100%; box-sizing:border-box; resize:none; min-height:64px; max-height:180px;
  padding:8px 10px; border-radius:8px; font:inherit; line-height:1.5;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1); outline:none;
}
.codexAnnotateInput:focus{border-color:var(--dsw-alias-brand-primary)}
.codexAnnotateInput::placeholder{color:var(--dsw-alias-label-secondary)}
.codexAnnotateError{margin-top:8px; font-size:12px; color:var(--dsw-alias-state-error-primary)}
.codexAnnotateFoot{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px}
.codexAnnotateHint{flex:1 1 auto; min-width:0; font-size:11px; line-height:1.35; color:var(--dsw-alias-label-secondary)}
.codexAnnotateActions{display:flex; align-items:center; gap:8px; flex:none}
.codexAnnotateBtn{
  height:28px; padding:0 12px; border-radius:7px; cursor:pointer; font:inherit; font-size:12px;
  background:transparent; color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);
}
.codexAnnotateBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.codexAnnotateBtn:disabled{opacity:.5; cursor:default}
.codexAnnotatePrimary{
  background:#2f6feb; border-color:transparent; color:#fff; font-weight:600;
}
.codexAnnotatePrimary:hover:not(:disabled){background:#3b7bf2}
.codexNotesTray{
  display:flex; flex-direction:column; gap:8px; box-sizing:border-box; width:100%;
  margin:0 0 8px; padding:8px 10px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  font-size:12.5px; color:var(--dsw-alias-label-primary);
}
.codexNotesItem{
  display:flex; flex-direction:column; gap:4px; padding-bottom:8px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
}
.codexNotesItem:last-of-type{border-bottom:0; padding-bottom:0}
.codexNotesItemHead{display:flex; align-items:flex-start; gap:8px}
.codexNotesItemQuote{
  flex:1 1 auto; min-width:0; font-size:11.5px; color:var(--dsw-alias-label-secondary);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.codexNotesItemRemove{
  flex:none; height:22px; padding:0 8px; border-radius:6px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1); background:transparent;
  color:var(--dsw-alias-label-secondary); font:inherit; font-size:11.5px;
}
.codexNotesItemRemove:hover{background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary)}
.codexNotesItemInput{
  box-sizing:border-box; width:100%; min-height:44px; resize:vertical; outline:none;
  padding:6px 8px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  font:inherit; font-size:12.5px; line-height:1.45;
}
.codexNotesItemInput:focus{border-color:#2f6feb}
.codexNotesItemMeta{
  font-size:10.5px; line-height:1.35; color:var(--dsw-alias-label-secondary);
  word-break:break-word;
}
.codexNotesTrayFoot{display:flex; align-items:center; justify-content:flex-end; gap:8px}
.codexNotesGhost,.codexNotesSend{height:28px; padding:0 12px; border-radius:7px; cursor:pointer; font:inherit; font-size:12px}
.codexNotesGhost{background:transparent; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1)}
.codexNotesGhost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.codexNotesSend{background:#2f6feb; color:#fff; border:1px solid transparent; font-weight:600}
.codexNotesSend:hover:not(:disabled){background:#3b7bf2}
.codexNotesGhost:disabled,.codexNotesSend:disabled{opacity:.5; cursor:default}
html body blockquote[data-codex-quote]{
  margin:3px 0 0 !important; padding:0 !important; border:0 !important;
  background:transparent !important; color:inherit !important; font-size:inherit !important;
}
html body blockquote[data-codex-quote]::before{
  content:"📎 " attr(data-codex-label) "  ▾";
  display:inline-flex; align-items:center; height:24px; padding:0 9px;
  border-radius:7px; cursor:pointer; user-select:none; white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);
  font-size:11.5px !important; line-height:1 !important; font-weight:400 !important;
}
html body blockquote[data-codex-quote][data-codex-open]::before{
  content:"📎 " attr(data-codex-label) "  ▴";
}
html body blockquote[data-codex-quote]:not([data-codex-open]) > *{ display:none !important; }
html body blockquote[data-codex-quote][data-codex-open] > *:first-child{ margin-top:6px !important; }
html body blockquote[data-codex-quote]:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:7px;
}
`

		// ── plugin entry ─────────────────────────────────────────────────────────

		function apply(ctx) {
			const style = document.createElement('style')
			style.setAttribute('data-codex-annotate', '')
			style.textContent = CSS
			document.head.appendChild(style)
			ctx.effect(() => () => {
				if (style.parentNode !== null) style.parentNode.removeChild(style)
			})

			const locale = ctx.get('locale')
			if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
				ctx.effect(() => {
					const disposers = []
					for (const id of ['zh-CN', 'zh', 'en-US', 'en']) {
						const dict = id.indexOf('zh') === 0 ? DICTS['zh-CN'] : DICTS['en-US']
						try {
							const dispose = locale.register(NS, id, dict)
							if (typeof dispose === 'function') disposers.push(dispose)
						} catch {
							/* custom namespaces may not be registrable in every profile */
						}
					}
					return () => {
						for (const dispose of disposers) dispose()
					}
				})
			}
			const t = makeTranslator(locale)

			// Staged notes sit above the composer and stay editable in place.
			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'codex-quote-notes',
						order: 30,
					},
					(slotProps) => h(NotesTray, { ...slotProps, t }),
				),
			)

			// The composer bridge lives on a floating, always-mounted session seat.
			ctx.slots.inject('conversation.input.overlay', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.overlay',
						id: 'codex-quote-bridge',
						order: 90,
					},
					(slotProps) => h(ComposerBridge, slotProps),
				),
			)

			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'codex-quote-reply',
						order: 30,
					},
					() => h(Annotator, { t }),
				),
			)
		}

		return {
			name: 'quote-reply-client',
			inject: ['slots'],
			apply,
		}
	},
})
