/**
 * Google Chat MCP Server
 *
 * User OAuth: the bot acts as the person who generated the refresh token —
 * it sees the spaces and DMs they are in and sends as them. Its own tile
 * (catalog `google-chat`) with its own OAuth client, separate from the
 * Google Workspace bundle, so Chat can be revoked on its own.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GCHAT_CLIENT_ID
 *   GCHAT_CLIENT_SECRET
 *   GCHAT_REFRESH_TOKEN  — scopes: chat.spaces.readonly, chat.memberships.readonly,
 *                          chat.messages (or chat.messages.readonly for read only)
 *   GCHAT_ALLOW_WRITE    — gates send_message.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_spaces          — spaces, group chats and DMs the user is in
 *   find_direct_message  — the DM space with one person (by email)
 *   list_members         — who is in a space
 *   list_messages        — recent messages in a space (newest first)
 *   read_message         — one message by resource name
 *   send_message         — post text to a space, optionally as a thread reply
 * ─────────────────────────────────────────────
 *
 * Quirks worth knowing:
 *   - The Chat API refuses every call (even with a valid token) until the
 *     GCP project has a Chat app configured: Google Chat API → Configuration.
 *   - With user auth, `sender.displayName` and member display names are often
 *     empty; `users/<id>` is what's reliably there. list_members is the way
 *     to tell people apart within a space.
 *   - Messages sent with user auth are plain text only (no cards).
 */

import { randomUUID }           from 'node:crypto';
import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';

import { wrapResult } from '../_shared/wrap-untrusted.js';
// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GCHAT_CLIENT_ID;
const CLIENT_SECRET = process.env.GCHAT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GCHAT_REFRESH_TOKEN;
const WRITES_OK     = String(process.env.GCHAT_ALLOW_WRITE || '').toLowerCase() === 'yes';

const CHAT_BASE = 'https://chat.googleapis.com/v1';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gchat-mcp] Missing OAuth config. Activate Google Chat first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Google Chat send access is disabled in this workspace. ' +
      'Open Integrations → Google Chat → Settings (gear) and set ' +
      '"Allow bot to send Google Chat messages as you" to Yes.',
    );
  }
}

// Accept "spaces/AAA", "AAA" or a pasted chat.google.com URL
// (…/room/AAA, …/dm/AAA, …/space/AAA) and return "spaces/AAA".
function spaceName(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('space is required (e.g. "spaces/AAAAxyz", from list_spaces).');
  const url = /chat\.google\.com\/.*?\/(?:room|dm|space)\/([A-Za-z0-9_-]+)/.exec(s);
  if (url) return `spaces/${url[1]}`;
  const m = /^(?:spaces\/)?([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) throw new Error(`Not a Chat space: "${s}". Use the name from list_spaces, e.g. "spaces/AAAAxyz".`);
  return `spaces/${m[1]}`;
}

function messageName(input) {
  const s = String(input || '').trim();
  if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/.test(s)) {
    throw new Error(`Not a Chat message name: "${s}". Use the "name" from list_messages, e.g. "spaces/AAA/messages/BBB".`);
  }
  return s;
}

// Resource names contain "/" that must stay literal in the path.
const path = (name) => name.split('/').map(encodeURIComponent).join('/');

function compactSpace(s) {
  if (!s) return null;
  return {
    name:           s.name,              // "spaces/AAA" — pass as `space`
    displayName:    s.displayName,       // empty for DMs
    spaceType:      s.spaceType,         // SPACE | GROUP_CHAT | DIRECT_MESSAGE
    singleUserBotDm: s.singleUserBotDm || undefined,
    threaded:       s.spaceThreadingState === 'THREADED_MESSAGES' || undefined,
    lastActiveTime: s.lastActiveTime,
    membershipCount: s.membershipCount?.joinedDirectHumanUserCount,
    uri:            s.spaceUri,
  };
}

function compactUser(u) {
  if (!u) return undefined;
  return { name: u.name, displayName: u.displayName || undefined, type: u.type };
}

function compactMessage(m) {
  if (!m) return null;
  return {
    name:        m.name,                // "spaces/AAA/messages/BBB"
    sender:      compactUser(m.sender),
    createTime:  m.createTime,
    lastUpdateTime: m.lastUpdateTime,
    text:        m.text,
    thread:      m.thread?.name,        // pass as `thread` to reply in it
    threadReply: m.threadReply || undefined,
    attachments: (m.attachment || []).map(a => ({ name: a.contentName, type: a.contentType })),
    deleted:     m.deletionMetadata ? true : undefined,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_spaces',
    description:
      'List the Google Chat spaces, group chats and direct messages the user is in. ' +
      'Returns name (use as `space`), displayName (empty for DMs), spaceType, lastActiveTime.',
    inputSchema: {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['SPACE', 'GROUP_CHAT', 'DIRECT_MESSAGE'], description: 'Only this kind of space.' },
        page_size:  { type: 'number', default: 100, description: 'Max spaces (max 1000).' },
        page_token: { type: 'string', description: 'nextPageToken from a previous call.' },
      },
    },
  },
  {
    name: 'find_direct_message',
    description: 'Find the direct-message space between the user and one person, by their email (or "users/<id>"). Returns the space, or null if they have never DMed.',
    inputSchema: {
      type: 'object',
      required: ['user'],
      properties: {
        user: { type: 'string', description: 'Email address, e.g. "anna@example.com", or "users/123456".' },
      },
    },
  },
  {
    name: 'list_members',
    description: 'List who is in a space: member (users/<id>, displayName when Google provides it, HUMAN or BOT) and role.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:      { type: 'string', description: 'From list_spaces, e.g. "spaces/AAAAxyz".' },
        page_size:  { type: 'number', default: 100, description: 'Max members (max 1000).' },
        page_token: { type: 'string' },
      },
    },
  },
  {
    name: 'list_messages',
    description:
      'List messages in a space, newest first. Returns name, sender, createTime, text, thread. ' +
      'Use `since` for "what happened today", `thread` to read one conversation thread.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:      { type: 'string', description: 'From list_spaces or find_direct_message.' },
        since:      { type: 'string', description: 'Only messages after this time (RFC 3339, e.g. "2026-10-25T00:00:00Z").' },
        thread:     { type: 'string', description: 'Only this thread, e.g. "spaces/AAA/threads/CCC".' },
        page_size:  { type: 'number', default: 25, description: 'Max messages (max 1000).' },
        page_token: { type: 'string' },
        oldest_first: { type: 'boolean', default: false, description: 'Chronological order instead of newest first.' },
      },
    },
  },
  {
    name: 'read_message',
    description: 'Read one message by its resource name ("spaces/AAA/messages/BBB"), with sender, text, thread and attachments.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'The "name" from list_messages.' },
      },
    },
  },
  {
    name: 'send_message',
    description:
      'Send a plain-text message to a space or DM, as the user. Pass `thread` to reply inside an existing thread. ' +
      'Google Chat formatting works in text (*bold*, _italic_, `code`, <users/123> mentions). ' +
      'Requires write permission (workspace-level toggle). Confirm the text and recipient with the user first.',
    inputSchema: {
      type: 'object',
      required: ['space', 'text'],
      properties: {
        space:  { type: 'string', description: 'From list_spaces or find_direct_message.' },
        text:   { type: 'string' },
        thread: { type: 'string', description: 'Reply in this thread ("spaces/AAA/threads/CCC", from list_messages). Falls back to a new thread if it no longer exists.' },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

const pageSize = (n, dflt) => Math.min(Math.max(Number(n) || dflt, 1), 1000);

async function handleListSpaces({ type, page_size, page_token } = {}) {
  const data = await api.get(`${CHAT_BASE}/spaces`, {
    query: {
      pageSize:  pageSize(page_size, 100),
      pageToken: page_token,
      filter:    type ? `spaceType = "${type}"` : undefined,
    },
  });
  return {
    spaces: (data?.spaces || []).map(compactSpace),
    nextPageToken: data?.nextPageToken,
  };
}

async function handleFindDirectMessage({ user }) {
  const u = String(user || '').trim();
  if (!u) throw new Error('user is required (an email address or "users/<id>").');
  try {
    const space = await api.get(`${CHAT_BASE}/spaces:findDirectMessage`, {
      query: { name: u.startsWith('users/') ? u : `users/${u}` },
    });
    return compactSpace(space);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function handleListMembers({ space, page_size, page_token }) {
  const data = await api.get(`${CHAT_BASE}/${path(spaceName(space))}/members`, {
    query: { pageSize: pageSize(page_size, 100), pageToken: page_token },
  });
  return {
    members: (data?.memberships || []).map(m => ({
      member: compactUser(m.member),
      role:   m.role,          // ROLE_MEMBER | ROLE_MANAGER
      state:  m.state,
    })),
    nextPageToken: data?.nextPageToken,
  };
}

async function handleListMessages({ space, since, thread, page_size, page_token, oldest_first = false }) {
  const filters = [];
  if (since) {
    const d = new Date(since);
    if (isNaN(d.getTime())) throw new Error(`Invalid since "${since}". Use RFC 3339, e.g. "2026-10-25T00:00:00Z".`);
    filters.push(`createTime > "${d.toISOString()}"`);
  }
  if (thread) {
    if (!/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/.test(thread)) {
      throw new Error(`Not a thread name: "${thread}". Use the "thread" from list_messages.`);
    }
    filters.push(`thread.name = ${thread}`);
  }
  const data = await api.get(`${CHAT_BASE}/${path(spaceName(space))}/messages`, {
    query: {
      pageSize:  pageSize(page_size, 25),
      pageToken: page_token,
      orderBy:   oldest_first ? 'createTime asc' : 'createTime desc',
      filter:    filters.length ? filters.join(' AND ') : undefined,
    },
  });
  return {
    messages: (data?.messages || []).map(compactMessage),
    nextPageToken: data?.nextPageToken,
  };
}

async function handleReadMessage({ message }) {
  return compactMessage(await api.get(`${CHAT_BASE}/${path(messageName(message))}`));
}

async function handleSendMessage({ space, text, thread }) {
  requireWrite();
  if (!String(text || '').trim()) throw new Error('text is required.');
  const body = { text };
  const query = { requestId: randomUUID() };
  if (thread) {
    body.thread = { name: thread };
    query.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }
  const sent = await api.post(`${CHAT_BASE}/${path(spaceName(space))}/messages`, body, { query });
  return compactMessage(sent);
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gchat-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_spaces':         result = await handleListSpaces(args || {});   break;
      case 'find_direct_message': result = await handleFindDirectMessage(args || {}); break;
      case 'list_members':        result = await handleListMembers(args || {});  break;
      case 'list_messages':       result = await handleListMessages(args || {}); break;
      case 'read_message':        result = await handleReadMessage(args || {});  break;
      case 'send_message':        result = await handleSendMessage(args || {});  break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return wrapResult(result, 'google-chat');
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[gchat-mcp] Ready\n');
