import { useState } from 'react';
import { Check, Plug, CheckCircle2, Plus, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import EditorHeader from '../EditorHeader.jsx';
import { useApi, invalidate } from '@/lib/useApi';
import useMe from '../useMe.js';
import { Skeleton } from '@/components/ui/Skeleton';
import { ActivateModal, RemoveDialog } from './IntegrationsDashboard.jsx';
import { TabBar } from './MemoryV4View.jsx';
import { AddMemberModal } from './TeamDashboard.jsx';
import StatusTag from './StatusTag.jsx';
import useOpenSetupOnce from './useOpenSetupOnce.js';
import { TEAM_URL, call, formatWhen, barBtn, barDanger, primaryBtn, quietBtn, outlineBtn } from './surface-screen-helpers.js';
import {
  StatePill, BottomBar, AccessDenied, NotConnected, GridList, Line, Name, EditButton, RoomAvatar, PersonAvatar, MemberPile, RoomPile, ModalRow, Switch, SettingsModal, LinkIdButton,
} from './surface-screen.jsx';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHANNELS_URL = '/api/team/channels?kind=gchat';
const CHANNELS_API = '/api/team/channels';
const INTEG_URL    = '/api/integrations';
const APP_ID       = 'google-chat-app';

/**
 * Google Chat — the surface's home in AI Settings, the Slack screen's twin:
 * the spaces (the ones waiting for a yes first), the people, the app's
 * settings in the bottom bar. Admins only.
 *
 * Where Chat differs: there is no install step (the Chat app is configured in
 * Google Cloud), and a Chat app cannot leave a space by itself — declining or
 * forgetting a space keeps the app there, silent, until someone in the space
 * removes it.
 */
export default function GoogleChatDashboard({ sidebarOpen }) {
  const { me, loading: meLoading } = useMe();
  const isAdmin = !!me?.isAdmin;
  const { data, loading, reload } = useApi(CHANNELS_URL);
  const integ = useApi(INTEG_URL);
  const roster = useApi(TEAM_URL);
  const groups = data?.groups || [];
  const pending = data?.pending || [];
  const pendingPeople = data?.pendingPeople || [];
  const canEdit = !!data?.canEdit;
  const refresh = () => { invalidate(CHANNELS_URL); reload(); };

  const gc = (integ.data?.integrations || []).find(i => i.id === APP_ID);
  const connected = !!gc?.active;
  const listener = gc?.listener || null;
  const [tab, setTab] = useState('spaces');
  const [setup, setSetup] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  useOpenSetupOnce({ ready: isAdmin && !!integ.data && !!gc, connected, open: () => setSetup(true) });

  if (!isAdmin) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={GoogleChatIcon} title="Google Chat" sidebarOpen={sidebarOpen} />
        <div className="flex-1 overflow-auto">{!meLoading && <AccessDenied text="Google Chat settings are managed by workspace admins. Ask an admin if you need a space approved." />}</div>
      </div>
    );
  }

  const entries = roster.data?.entries || [];
  const avatars = {};
  // A teammate in a space is named as the roster names them, whatever the space recorded.
  const names = {};
  for (const e of entries) if (e.gchatUserId) { avatars[String(e.gchatUserId)] = e.avatarUrl; names[String(e.gchatUserId)] = e.displayName || e.slug || e.email; }
  const onPeopleChanged = () => { refresh(); invalidate(TEAM_URL); roster.reload(); };
  const up = connected && !!listener?.connected;
  const pillText = !connected ? 'Not connected' : listener?.connected ? 'Listening' : listener?.error ? 'Not connected' : 'Connecting';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={GoogleChatIcon} title="Google Chat" sidebarOpen={sidebarOpen}
        meta={<StatePill ok={up} icon={up ? CheckCircle2 : Plug} title={pillTitle(listener)}>{pillText}</StatePill>} />

      <div className="flex-1 overflow-auto">
        {gc && !connected ? (
          <NotConnected mark={`${BASE}/integrations/gchat.svg`} name="Google Chat" onSetUp={() => setSetup(true)}
            text="Connect your own Google Chat app: people can then write to the assistant there, and spaces you approve get it too. The setup is done in Google Cloud and the Admin console; it takes about half an hour." />
        ) : (
        <div className="flex max-w-2xl flex-col gap-5 px-6 pb-12 pt-2">
          <TabBar value={tab} onChange={setTab} tabs={[['spaces', 'Spaces', pending.length], ['people', 'People', pendingPeople.length]]} />
          {tab === 'spaces' ? (
            loading && !data ? <><Skeleton className="h-10 rounded-[6px]" /><Skeleton className="h-10 rounded-[6px]" /></> : (
              <GridList>
                {pending.map(p => <PendingLine key={p.chatId} entry={p} onChanged={refresh} />)}
                {groups.map(g => <SpaceLine key={g.chatId} group={g} canEdit={canEdit} avatars={avatars} names={names} onChanged={refresh} />)}
              </GridList>
            )
          ) : (
            <GridList>
              {pendingPeople.map(p => <StrangerLine key={p.id} person={p} onChanged={onPeopleChanged} />)}
              {entries.map(p => <PersonLine key={p.email} person={p} onChanged={onPeopleChanged} />)}
            </GridList>
          )}
        </div>
        )}
      </div>

      <BottomBar label={!connected ? 'Google Chat app' : listener?.error && !listener.connected ? `Not connected: ${listener.error}` : listener?.app ? `Google Chat app · ${listener.app}` : 'Google Chat app'}>
        {gc && <button type="button" onClick={() => setSetup(true)} className={barBtn}>{connected ? 'Manage settings' : 'Set up'}</button>}
        {connected && gc && <button type="button" onClick={() => setDisconnect(true)} className={barDanger}>Disconnect</button>}
      </BottomBar>

      {setup && gc && (
        <ActivateModal integration={gc} onClose={() => setSetup(false)} onSuccess={() => { setSetup(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
      {disconnect && gc && (
        <RemoveDialog integration={gc} title="Disconnect Google Chat?"
          body="This erases the stored key and takes the assistant off Google Chat. Approved spaces and linked people are kept: reconnect any time by adding the key again. The Chat app itself stays in Google Cloud."
          confirmLabel="Disconnect" busyLabel="Disconnecting…" doneLabel="Disconnected"
          onClose={() => setDisconnect(false)} onSuccess={() => { setDisconnect(false); invalidate(INTEG_URL); integ.reload(); }} />
      )}
    </div>
  );
}

// Since when, and the last outage, on hover of the status pill only.
function pillTitle(listener) {
  if (!listener?.connected) return undefined;
  const out = listener.outages?.length ? listener.outages[listener.outages.length - 1] : null;
  return `Listening since ${formatWhen(listener.since)}${out ? ` · last outage ${formatWhen(out.from)} (nothing was lost: Google kept the messages)` : ''}`;
}

/* ─── spaces ────────────────────────────────────────────────────────────── */

// One line on how the assistant behaves in the space.
function stateLine(g) {
  const outsiders = g.audience?.outsiders?.length || 0;
  if (g.paused) return `${outsiders} ${outsiders === 1 ? 'member' : 'members'} not on the team`;
  const how = g.requireMention ? 'Only when called' : 'Joins in on its own';
  return g.openAudience ? `${how} · open to outsiders` : how;
}

function SpaceLine({ group, canEdit, avatars, names, onChanged }) {
  const [open, setOpen] = useState(false);
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members).map(([id, n]) => [id, names?.[String(id)] || n]) : [];
  return (
    <Line
      who={<><RoomAvatar icon={MessagesSquare} /><Name>{group.title || group.chatId}</Name></>}
      state={group.paused ? <StatusTag tone="paused">Paused</StatusTag> : <StatusTag tone="active">Active</StatusTag>}
      text={stateLine(group)}
      pile={members.length > 0 && <MemberPile members={members} avatars={avatars} />}
      actions={<>
        {canEdit && <EditButton onClick={() => setOpen(true)} />}
        {open && <SpaceModal group={group} avatars={avatars} names={names} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
      </>}
    />
  );
}

function PendingLine({ entry, onChanged }) {
  const [busy, setBusy] = useState(null);
  const act = async (approve) => {
    setBusy(approve ? 'approve' : 'decline');
    try {
      if (approve) await call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: entry.chatId }) });
      else await call(`${CHANNELS_API}/${encodeURIComponent(entry.chatId)}`, { method: 'DELETE' });
      onChanged();
    } catch { setBusy(null); }
  };
  return (
    <Line
      who={<><RoomAvatar icon={MessagesSquare} /><Name>{entry.title || entry.chatId}</Name></>}
      state={<StatusTag tone="soon">Waiting</StatusTag>}
      text={`Added by ${entry.inviterSlug || 'someone not on the team'}${entry.members ? ` · ${entry.members} members` : ''}`}
      actions={<span className="inline-flex items-center gap-2 whitespace-nowrap">
        <button type="button" disabled={!!busy} onClick={() => act(false)} className={quietBtn}
          title="The assistant stays in the space, silent: a Chat app cannot leave by itself. Someone in the space can remove it.">Decline</button>
        <button type="button" disabled={!!busy} onClick={() => act(true)} className={primaryBtn}><Check className="size-3.5" strokeWidth={2} />Approve</button>
      </span>}
    />
  );
}

function SpaceModal({ group, avatars, names, onClose, onSaved }) {
  const [ambient, setAmbient] = useState(!group.requireMention);
  const [openAudience, setOpenAudience] = useState(!!group.openAudience);
  const [mine, setMine] = useState(group.privateAnswers !== 'off');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const members = group.members && typeof group.members === 'object' ? Object.entries(group.members).map(([id, n]) => [id, names?.[String(id)] || n]) : [];
  const run = async (what, fn) => { setBusy(what); setErr(''); try { await fn(); onSaved(); } catch (e) { setErr(e.message); setBusy(null); } };
  return (
    <SettingsModal avatar={<RoomAvatar icon={MessagesSquare} />} title={group.title || group.chatId} sub={group.chatId} onClose={onClose}
      onSave={() => run('save', () => call(CHANNELS_API, { method: 'POST', body: JSON.stringify({ chatId: group.chatId, requireMention: !ambient, openAudience, privateAnswers: mine ? 'team' : 'off' }) }))}
      saving={busy === 'save'} busy={busy} err={err}
      danger dangerLabel="Forget space" dangerBusyLabel="Forgetting…" onDanger={() => run('danger', () => call(`${CHANNELS_API}/${encodeURIComponent(group.chatId)}`, { method: 'DELETE' }))}>
      <ModalRow label="Joins in on its own" tip="On: the assistant follows the conversation and chimes in when it can help. Off (only when called): it reads everything for context but stays out of sight, answering only an @mention or a question or task for it in a thread it is in.">
        <Switch on={ambient} onToggle={() => setAmbient(v => !v)} />
      </ModalRow>
      <ModalRow label="Open to outsiders" tip="Whether the assistant keeps working when someone outside the team is in the space. It then uses this space's own memory only, never the team's.">
        <Switch on={openAudience} onToggle={() => setOpenAudience(v => !v)} />
      </ModalRow>
      <ModalRow label="Answers from the asker's own memory" tip="Whether a teammate who asks about their own matters here gets an answer from what they told the assistant in their own conversations, said in this space. Only while everyone in the space is on the team; never anyone else's memory.">
        <Switch on={mine} onToggle={() => setMine(v => !v)} />
      </ModalRow>
      <ModalRow label="In the space" tip="Who is in the space. Someone outside the team pauses the assistant here, unless the space is open to outsiders. Forgetting the space makes the assistant silent there; to take it out, remove it in Google Chat (space menu → Apps & integrations).">
        <RoomPile members={members} outsiders={group.audience?.outsiders || []} avatars={avatars} />
      </ModalRow>
    </SettingsModal>
  );
}

/* ─── people ────────────────────────────────────────────────────────────── */

function PersonLine({ person, onChanged }) {
  const name = person.displayName || person.slug || person.email;
  return (
    <Line
      who={<><PersonAvatar name={name} avatar={person.avatarUrl} /><Name>{name}</Name></>}
      state={person.gchatUserId ? <StatusTag tone="active">Linked</StatusTag> : <StatusTag tone="soon">Not seen yet</StatusTag>}
      text={{ mono: true, value: person.gchatUserId || '' }}
      actions={<LinkIdButton person={person} field="gchatUserId" value={person.gchatUserId} what="Google Chat link" onChanged={onChanged}
        placeholder={{ label: 'Google Chat user', example: 'e.g. users/123456789012345678901' }}
        hint="Normally not needed: a person is linked by email the first time they write, or when they are seen in a space. Use this when their Google account's email differs from the team's. Their id is the number in their user page's address in the Admin console, written as users/<number>." />}
    />
  );
}

// Someone who wrote to the assistant on Google Chat without being on the
// team: Add opens the Team page's invite with the email prefilled; once they
// are on the roster their Chat account is linked at once — we know its id.
function StrangerLine({ person, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const name = person.name || person.email || person.id;
  const added = async (email) => {
    setAdding(false);
    try {
      await call(`${TEAM_URL}/${encodeURIComponent(email)}`, { method: 'PATCH', body: JSON.stringify({ gchatUserId: person.id }) });
      await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
    } catch { /* on the team already; the link happens on their next message */ }
    onChanged();
  };
  const forget = async () => { setBusy('forget'); try { await call(`${CHANNELS_API}/pending-people/${encodeURIComponent(person.id)}`, { method: 'DELETE' }); onChanged(); } catch { setBusy(null); } };
  return (
    <Line
      who={<><PersonAvatar name={name} /><Name>{name}</Name></>}
      state={<StatusTag tone="soon">Not on the team</StatusTag>}
      text={person.email || 'no email from Google Chat'}
      actions={<span className="inline-flex items-center gap-2 whitespace-nowrap">
        <button type="button" disabled={!!busy} onClick={forget} className={quietBtn}>Forget</button>
        <button type="button" disabled={!!busy} onClick={() => setAdding(true)} className={outlineBtn}><Plus className="size-3" strokeWidth={2} /> Add</button>
        {adding && <AddMemberModal initialEmail={person.email || ''} onClose={() => setAdding(false)} onSuccess={added} />}
      </span>}
    />
  );
}

function GoogleChatIcon({ className }) {
  return <img src={`${BASE}/integrations/gchat.svg`} alt="" className={cn('object-contain', className)} />;
}
