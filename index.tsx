/*
 * MultiForward v2 - a Vencord userplugin
 *
 * Select several messages (Alt+Click, hover button, or right-click menu),
 * then press "Forward". Discord's NORMAL forward dialog opens. Whatever
 * destinations you pick in it, the rest of your selected messages are
 * forwarded there too, in chronological order.
 *
 * How it works (no Discord internals needed):
 *   1. Borrows the native "Forward" action from the message context menu.
 *   2. Opens the native dialog for one "anchor" message.
 *   3. Watches for that anchor's forward request and replays the other
 *      selected messages to the same destination right after it.
 *
 * Install: src/userplugins/multiForward/index.tsx, then `pnpm build`.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore,
    ContextMenuApi,
    FluxDispatcher,
    Menu,
    MessageStore,
    RestAPI,
    showToast,
    SnowflakeUtils,
    UserStore
} from "@webpack/common";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    clickWhenActive: {
        type: OptionType.BOOLEAN,
        description:
        "While at least one message is selected, a plain click on a message toggles it (links, buttons and media still work normally)",
                                      default: true
    },
    delayMs: {
        type: OptionType.NUMBER,
        description: "Delay between each extra forwarded message in milliseconds (avoids rate limits)",
                                      default: 700
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log what the plugin sees to the console (filter by \"[MultiForward]\")",
                                      default: false
    }
});

// Use string literals directly — Vencord's showToast accepts "success" | "failure" etc.
const TOAST = {
    SUCCESS: "success" as const,
    FAILURE: "failure" as const,
};

const dbg = (...args: any[]) => {
    if (settings.store.debug) console.log("[MultiForward]", ...args);
};

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

interface Selected {
    id: string;
    channel_id: string;
    guild_id?: string;
}

const selected = new Map<string, Selected>();

let barEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let highlightStyle: HTMLStyleElement | null = null;
let baseStyle: HTMLStyleElement | null = null;

const byAge = (a: Selected, b: Selected) => {
    const x = BigInt(a.id), y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
};

const sortedSelection = () => [...selected.values()].sort(byAge);

function toggle(message: { id: string; channel_id: string; }) {
    if (selected.has(message.id)) {
        selected.delete(message.id);
    } else {
        selected.set(message.id, {
            id: message.id,
            channel_id: message.channel_id,
            guild_id: ChannelStore.getChannel(message.channel_id)?.guild_id
        });
    }
    refresh();
}

function clearSelection() {
    selected.clear();
    refresh();
}

function refresh() {
    if (highlightStyle) {
        highlightStyle.textContent = [...selected.values()]
        .map(
            s => `[id="chat-messages-${s.channel_id}-${s.id}"] {
                background-color: var(--brand-500-alpha-15, rgba(88,101,242,.18)) !important;
                box-shadow: inset 3px 0 0 var(--brand-500, #5865f2);
            }`
        )
        .join("\n");
    }

    if (barEl && countEl) {
        const n = selected.size;
        barEl.style.display = n > 0 ? "flex" : "none";
        countEl.textContent = `${n} message${n === 1 ? "" : "s"} selected`;
    }
}

// ---------------------------------------------------------------------------
// DOM: floating bar + styles
// ---------------------------------------------------------------------------

const BASE_CSS = `
.vc-multiforward-bar {
    position: fixed;
    bottom: 90px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: none;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--background-floating, #111214);
    color: var(--text-normal, #fff);
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    font-size: 14px;
}
.vc-multiforward-bar button {
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-weight: 500;
    font-size: 14px;
}
.vc-multiforward-bar .vc-mf-forward { background: var(--brand-500, #5865f2); color: #fff; }
.vc-multiforward-bar .vc-mf-forward:hover { filter: brightness(1.1); }
.vc-multiforward-bar .vc-mf-clear { background: var(--button-secondary-background, #4e5058); color: #fff; }
.vc-multiforward-bar .vc-mf-clear:hover { filter: brightness(1.1); }
`;

function mountUi() {
    baseStyle = document.createElement("style");
    baseStyle.id = "vc-multiforward-style";
    baseStyle.textContent = BASE_CSS;
    document.head.appendChild(baseStyle);

    highlightStyle = document.createElement("style");
    highlightStyle.id = "vc-multiforward-highlight";
    document.head.appendChild(highlightStyle);

    barEl = document.createElement("div");
    barEl.className = "vc-multiforward-bar";

    countEl = document.createElement("span");

    const fwd = document.createElement("button");
    fwd.className = "vc-mf-forward";
    fwd.textContent = "Forward";
    fwd.onclick = forwardFromBar;

    const clr = document.createElement("button");
    clr.className = "vc-mf-clear";
    clr.textContent = "Clear";
    clr.onclick = clearSelection;

    barEl.append(countEl, fwd, clr);
    document.body.appendChild(barEl);

    refresh();
}

function unmountUi() {
    barEl?.remove();
    baseStyle?.remove();
    highlightStyle?.remove();
    barEl = countEl = null;
    baseStyle = highlightStyle = null;
}

// ---------------------------------------------------------------------------
// Click / key handling
// ---------------------------------------------------------------------------

const INTERACTIVE =
'a, button, input, textarea, select, video, audio, [role="button"], [role="menuitem"], [class*="reaction"]';

function onClick(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const li = target?.closest?.('[id^="chat-messages-"]') as HTMLElement | null;
    if (!target || !li) return;

    const activeMode = selected.size > 0 && settings.store.clickWhenActive;
    if (!e.altKey && !activeMode) return;
    if (!e.altKey && target.closest(INTERACTIVE)) return;

    const match = /^chat-messages-(\d+)-(\d+)$/.exec(li.id);
    if (!match) return;
    const [, channelId, messageId] = match;

    const message = MessageStore.getMessage(channelId, messageId);
    if (!message) return;

    e.preventDefault();
    e.stopPropagation();
    toggle(message);
}

function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || selected.size === 0) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
    if (t?.isContentEditable) return;
    if (document.querySelector('[class*="layer_"] [role="dialog"]')) return;
    clearSelection();
}

// ---------------------------------------------------------------------------
// Native forward dialog + replaying the extra messages
// ---------------------------------------------------------------------------

interface Session {
    anchorId: string;
    extras: Selected[];
    expires: number;
    cleared: boolean;
    handled: Map<string, number>;
}

let session: Session | null = null;
let pendingAutoFor: string | null = null;
let origPost: any = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Find the native "Forward" menu item inside the message context menu children. */
function findForwardItem(node: any): any {
    if (!node) return null;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findForwardItem(child);
            if (found) return found;
        }
        return null;
    }
    const p = node.props;
    if (!p) return null;
    if (
        typeof p.id === "string" &&
        /forward/i.test(p.id) &&
        !p.id.startsWith("vc-mf") &&
        typeof p.action === "function"
    ) return node;
    return findForwardItem(p.children);
}

/** Open the native forward dialog for `anchor` and arm the replay of everything else. */
function startNativeForward(anchor: { id: string; channel_id: string; }, nativeAction: (() => void) | undefined) {
    if (!nativeAction) {
        showToast("Couldn't find Discord's native Forward action", TOAST.FAILURE as any);
        return;
    }

    if (!selected.has(anchor.id)) toggle(anchor);

    session = {
        anchorId: anchor.id,
        extras: sortedSelection().filter(m => m.id !== anchor.id),
        expires: Date.now() + 90_000,
        cleared: false,
        handled: new Map()
    };
    dbg("armed", session);

    nativeAction();
}

/** Bar button: right-click the oldest visible selected message in code, and auto-trigger Forward. */
function forwardFromBar() {
    if (selected.size === 0) return;

    for (const m of sortedSelection()) {
        const li = document.getElementById(`chat-messages-${m.channel_id}-${m.id}`);
        if (!li) continue;

        const r = li.getBoundingClientRect();
        const el = (li.querySelector('[class*="contents_"]') ?? li.firstElementChild ?? li) as HTMLElement;

        pendingAutoFor = m.id;
        setTimeout(() => { if (pendingAutoFor === m.id) pendingAutoFor = null; }, 1500);

        el.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 2,
            clientX: r.left + 24,
            clientY: r.top + 12
        }));
        return;
    }

    showToast("Scroll so one of your selected messages is visible, or right-click one and use Forward", TOAST.FAILURE as any);
}

async function sendExtras(targetChannelId: string, extras: Selected[]) {
    let ok = 0, failed = 0;

    for (const msg of extras) {
        await sleep(Math.max(0, settings.store.delayMs ?? 700));
        try {
            await origPost.call(RestAPI, {
                url: `/channels/${targetChannelId}/messages`,
                body: {
                    content: "",
                    flags: 0,
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                                message_reference: {
                                    type: 1, // FORWARD
                                    message_id: msg.id,
                                    channel_id: msg.channel_id,
                                    guild_id: msg.guild_id
                                }
                }
            });
            ok++;
        } catch (err) {
            console.error("[MultiForward] failed to forward", msg, err);
            failed++;
        }
    }

    if (failed) showToast(`Forwarded ${ok + 1}, ${failed} failed (see console)`, TOAST.FAILURE as any);
    else if (ok) showToast(`Forwarded ${ok + 1} messages`, TOAST.SUCCESS as any);
}

/** Shared by the REST hook and the Flux hook: replay the extras to `channelId` once per forward. */
function maybeReplay(refType: any, refMessageId: any, channelId: string, source: string) {
    if (!session || Date.now() > session.expires) return;
    if (refType !== 1 || String(refMessageId) !== session.anchorId) return;

    // Both hooks can fire for the same send; ignore repeats for the same channel within 5s.
    const last = session.handled.get(channelId) ?? 0;
    if (Date.now() - last < 5000) return;
    session.handled.set(channelId, Date.now());

    dbg(`anchor forward detected via ${source} -> channel ${channelId}, replaying ${session.extras.length} extra(s)`);

    const { extras } = session;
    if (extras.length) void sendExtras(channelId, extras);

    if (!session.cleared) {
        session.cleared = true;
        setTimeout(clearSelection, 2500);
    }
}

/** REST hook: runs after every POST. */
function onPostFinished(req: any) {
    if (!session) return;
    const ref = req?.body?.message_reference ?? req?.body?.messageReference;
    if (ref) dbg("REST post with message_reference", req.url, ref);
    if (!ref) return;

    const m = /\/channels\/(\d+)\/messages\/?$/.exec(String(req.url ?? ""));
    if (!m) return;
    maybeReplay(ref.type, ref.message_id ?? ref.messageId, m[1], "REST");
}

/** Flux hook: runs when our own message shows up (optimistic echo or real). Independent of how Discord sends it. */
function onMessageCreate(action: any) {
    if (!session) return;
    const msg = action?.message;
    if (!msg || msg.author?.id !== UserStore.getCurrentUser()?.id) return;

    const ref = msg.message_reference ?? msg.messageReference;
    if (ref) dbg("MESSAGE_CREATE with reference", action.channelId ?? msg.channel_id, ref);
    if (!ref) return;

    maybeReplay(
        ref.type,
        ref.message_id ?? ref.messageId,
        String(action.channelId ?? msg.channel_id ?? msg.channelId),
                "Flux"
    );
}

function installPostHook() {
    origPost = RestAPI.post;
    (RestAPI as any).post = async function (this: any, req: any, ...rest: any[]) {
        const result = await origPost.call(this ?? RestAPI, req, ...rest);
        try {
            onPostFinished(req);
        } catch (err) {
            console.error("[MultiForward] hook error", err);
        }
        return result;
    };
}

function removePostHook() {
    if (origPost) (RestAPI as any).post = origPost;
    origPost = null;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const ForwardIcon = ({ className }: { className?: string; }) => (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 8V4l8 8-8 8v-4H4V8z" />
    </svg>
);

export default definePlugin({
    name: "MultiForward",
    description:
    "Select multiple messages (Alt+Click, hover button or right-click menu) and forward them all through Discord's normal forward dialog",
                            authors: [{ name: "You", id: 0n }],
                            settings,

                            start() {
                                mountUi();
                                installPostHook();
                                FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
                                document.addEventListener("click", onClick, true);
                                document.addEventListener("keydown", onKeyDown, true);
                            },

                            stop() {
                                document.removeEventListener("click", onClick, true);
                                document.removeEventListener("keydown", onKeyDown, true);
                                removePostHook();
                                FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
                                selected.clear();
                                session = null;
                                pendingAutoFor = null;
                                unmountUi();
                            },

                            messagePopoverButton: {
                                icon: ForwardIcon,
                                render(message: any) {
                                    return {
                                        label: selected.has(message.id) ? "Deselect message" : "Select for multi-forward",
                            icon: ForwardIcon,
                            message,
                            channel: ChannelStore.getChannel(message.channel_id),
                            onClick: () => toggle(message)
                                    };
                                }
                            },

                            contextMenus: {
                                message(children: any[], { message }: { message: any; }) {
                                    const nativeAction: (() => void) | undefined = findForwardItem(children)?.props?.action;

                                    // Triggered from the floating bar: fire the native Forward immediately and hide the menu.
                                    if (pendingAutoFor === message.id) {
                                        pendingAutoFor = null;
                                        setTimeout(() => {
                                            ContextMenuApi.closeContextMenu();
                                            startNativeForward(message, nativeAction);
                                        }, 0);
                                        return;
                                    }

                                    const items: any[] = [
                                        <Menu.MenuSeparator key="vc-mf-sep" />,
                                        <Menu.MenuItem
                                        key="vc-mf-toggle"
                                        id="vc-mf-toggle"
                                        label={selected.has(message.id) ? "Deselect for Multi-Forward" : "Select for Multi-Forward"}
                                        action={() => toggle(message)}
                                        />
                                    ];

                                    if (selected.size > 0) {
                                        items.push(
                                            <Menu.MenuItem
                                            key="vc-mf-forward"
                                            id="vc-mf-forward"
                                            label={`Forward ${selected.size} Selected…`}
                                            action={() => startNativeForward(message, nativeAction)}
                                            />,
                                            <Menu.MenuItem
                                            key="vc-mf-clear"
                                            id="vc-mf-clear"
                                            label="Clear Selection"
                                            color="danger"
                                            action={clearSelection}
                                            />
                                        );
                                    }

                                    children.push(...items);
                                }
                            }
});
