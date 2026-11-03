import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Archive, Check, Copy, MessageSquarePlus, Plus, RefreshCw, Send, Shield, UserRound, X } from 'lucide-react';
import type { AgentProfile, WorkspaceProject } from '../types';
import ActivityOrb from './ActivityOrb';

type ThreadScope = 'project' | 'selected' | 'open' | 'external';
type ThreadPost = {
  id: string;
  author: { type: 'user' | 'agent' | 'external'; id: string; label?: string };
  body: string;
  mentions: string[];
  createdAt: number;
  kind?: 'message' | 'user_help';
  topicId?: string;
  readBy?: string[];
  reactions?: Array<{ emoji: string; actors: string[] }>;
};
type SpaceTopic = {
  id: string;
  title: string;
  createdByAgentId: string;
  reviewerAgentId: string;
  createdAt: number;
  updatedAt: number;
  lastReviewedAt: number;
  reviewScheduledAt?: number;
};
type AgentThread = {
  id: string;
  title: string;
  scope: ThreadScope;
  projectId?: string;
  participants: string[];
  externalContactIds: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  posts: ThreadPost[];
  topics?: SpaceTopic[];
};
type ThreadContact = { id: string; label: string; createdAt: number; active: boolean };
type CreateContact = ThreadContact & { token: string };
type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

function timestamp(value: number): string {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ThreadsPanel({ request, projects, profiles, selectedProjectId, requestedThreadId }: {
  request: Request;
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  selectedProjectId: string;
  requestedThreadId?: string;
}) {
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [contacts, setContacts] = useState<ThreadContact[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [scope, setScope] = useState<ThreadScope>(selectedProjectId ? 'project' : 'selected');
  const [projectId, setProjectId] = useState(selectedProjectId);
  const [participants, setParticipants] = useState<string[]>([]);
  const [reviewerAgentId, setReviewerAgentId] = useState('main');
  const [externalContactId, setExternalContactId] = useState('');
  const [title, setTitle] = useState('');
  const [topicTitle, setTopicTitle] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [topicComposerOpen, setTopicComposerOpen] = useState(false);
  const [topicDraft, setTopicDraft] = useState('');
  const [topicReviewerAgentId, setTopicReviewerAgentId] = useState('main');
  const [draft, setDraft] = useState('');
  const [contactLabel, setContactLabel] = useState('');
  const [newContact, setNewContact] = useState<CreateContact | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [threadList, contactList] = await Promise.all([
      request<AgentThread[]>('/api/threads'),
      request<ThreadContact[]>('/api/threads/contacts'),
    ]);
    setThreads(threadList);
    setContacts(contactList);
    setSelectedId(current => current && threadList.some(thread => thread.id === current) ? current : threadList[0]?.id ?? '');
    setExternalContactId(current => current && contactList.some(contact => contact.id === current) ? current : contactList[0]?.id ?? '');
    setError('');
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (initial = false) => {
      try {
        await refresh();
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not refresh spaces.');
      } finally {
        if (!cancelled) {
          if (initial) setLoading(false);
          timer = window.setTimeout(() => void poll(), 60_000 + Math.floor(Math.random() * 8_001));
        }
      }
    };
    void poll(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);

  const refreshManually = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not refresh agent threads.');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  const createTopic = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedThread || !topicDraft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const updated = await request<AgentThread>(`/api/threads/${encodeURIComponent(selectedThread.id)}/topics`, {
        method: 'POST',
        body: JSON.stringify({ title: topicDraft, reviewerAgentId: topicReviewerAgentId }),
      });
      setThreads(current => current.map(thread => thread.id === updated.id ? updated : thread));
      setSelectedTopicId(updated.topics?.at(-1)?.id ?? '');
      setTopicDraft('');
      setTopicReviewerAgentId('main');
      setTopicComposerOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the space topic.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (requestedThreadId && threads.some(thread => thread.id === requestedThreadId)) {
      setSelectedId(requestedThreadId);
    }
  }, [requestedThreadId, threads]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    request<AgentThread>(`/api/threads/${encodeURIComponent(selectedId)}/read`, { method: 'POST', body: JSON.stringify({}) })
      .then(updated => {
        if (!cancelled) setThreads(current => current.map(thread => thread.id === updated.id ? updated : thread));
      })
      .catch(failure => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Thread read status could not be updated.');
      });
    return () => { cancelled = true; };
  }, [request, selectedId]);

  const selectedThread = threads.find(thread => thread.id === selectedId);
  const inviteOptions = useMemo(() => scope === 'project'
    ? profiles.filter(profile => profile.projectId === projectId)
    : profiles, [profiles, projectId, scope]);
  const reviewerOptions = useMemo(() => scope === 'open'
    ? profiles
    : profiles.filter(profile => participants.includes(profile.id)), [profiles, participants, scope]);
  const selectedTopic = selectedThread?.topics?.find(topic => topic.id === selectedTopicId);
  const visiblePosts = selectedThread?.posts.filter(post => !selectedTopicId || post.topicId === selectedTopicId) ?? [];
  const topicReviewerOptions = useMemo(() => selectedThread?.scope === 'open'
    ? profiles
    : profiles.filter(profile => selectedThread?.participants.includes(profile.id)), [profiles, selectedThread]);

  useEffect(() => {
    if (reviewerAgentId !== 'main' && !reviewerOptions.some(profile => profile.id === reviewerAgentId)) setReviewerAgentId('main');
  }, [reviewerAgentId, reviewerOptions]);

  useEffect(() => {
    if (topicReviewerAgentId !== 'main' && !topicReviewerOptions.some(profile => profile.id === topicReviewerAgentId)) {
      setTopicReviewerAgentId('main');
    }
  }, [topicReviewerAgentId, topicReviewerOptions]);

  useEffect(() => {
    if (selectedThread && selectedTopicId && !selectedThread.topics?.some(topic => topic.id === selectedTopicId)) {
      setSelectedTopicId('');
    }
  }, [selectedThread, selectedTopicId]);

  const createThread = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await request<AgentThread>('/api/threads', {
        method: 'POST',
        body: JSON.stringify({
          title,
          scope,
          ...(scope === 'project' ? { projectId } : {}),
          ...(scope === 'project' || scope === 'selected' ? { participants } : {}),
          ...(scope === 'external' ? { externalContactIds: [externalContactId] } : {}),
          ...(scope !== 'external' ? {
            topicTitle: topicTitle.trim() || title.trim(),
            reviewerAgentId,
          } : {}),
        }),
      });
      await refresh();
      setSelectedId(created.id);
      setSelectedTopicId(created.topics?.[0]?.id ?? '');
      setTitle('');
      setTopicTitle('');
      setParticipants([]);
      setReviewerAgentId('main');
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the thread.');
    } finally {
      setBusy(false);
    }
  };

  const postMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedThread || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const updated = await request<AgentThread>(`/api/threads/${encodeURIComponent(selectedThread.id)}/posts`, {
        method: 'POST',
        body: JSON.stringify({ body: draft, ...(selectedTopicId ? { topicId: selectedTopicId } : {}) }),
      });
      setThreads(current => current.map(thread => thread.id === updated.id ? updated : thread).sort((left, right) => right.updatedAt - left.updatedAt));
      setDraft('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not post to the thread.');
    } finally {
      setBusy(false);
    }
  };

  const archiveThread = async () => {
    if (!selectedThread || !window.confirm(`Archive “${selectedThread.title}”?`)) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/threads/${encodeURIComponent(selectedThread.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not archive the thread.');
    } finally {
      setBusy(false);
    }
  };

  const toggleReaction = async (threadId: string, postId: string, emoji: string) => {
    try {
      const updated = await request<AgentThread>(`/api/threads/${encodeURIComponent(threadId)}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ postId, emoji }),
      });
      setThreads(current => current.map(thread => thread.id === updated.id ? updated : thread));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Reaction could not be saved.');
    }
  };

  const addContact = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await request<CreateContact>('/api/threads/contacts', {
        method: 'POST',
        body: JSON.stringify({ label: contactLabel }),
      });
      setNewContact(created);
      setContactLabel('');
      await refresh();
      setExternalContactId(created.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the external contact.');
    } finally {
      setBusy(false);
    }
  };

  const revokeContact = async (contact: ThreadContact) => {
    if (!window.confirm(`Revoke external contact “${contact.label}”? This prevents future access to its threads.`)) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/threads/contacts/${encodeURIComponent(contact.id)}`, { method: 'DELETE' });
      await refresh();
      setNewContact(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not revoke the external contact.');
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!newContact) return;
    try {
      await navigator.clipboard.writeText(newContact.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not copy the contact token.');
    }
  };

  return (
    <div className="threads-panel">
      <div className="page-panel-toolbar threads-panel-toolbar">
        <div className="page-panel-toolbar-copy">
          <span className="eyebrow">MULTI-AGENT COLLABORATION</span>
            <p>Topic-focused spaces, project coordination, and secure external contacts.</p>
        </div>
        <div className="page-panel-toolbar-actions">
          <div className="page-panel-counts" aria-label="Thread summary">
            <span><strong>{threads.length}</strong> spaces</span>
            <span><strong>{contacts.length}</strong> contacts</span>
          </div>
          <button className={`icon-button refresh-button${refreshing ? ' is-refreshing' : ''}`} type="button" onClick={() => void refreshManually()} disabled={refreshing} aria-label="Refresh spaces" title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>
      {error && <div className="threads-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refreshManually()} aria-label="Retry loading threads" title="Retry"><RefreshCw size={13} /></button></div>}
      {loading ? <div className="loading-state threads-loading-state"><ActivityOrb label="Loading spaces" loading /><span>Loading spaces…</span></div> : <div className="threads-layout">
        <section className="threads-list" aria-label="Agent spaces">
          <div className="threads-list-heading"><span>SPACES</span><span>{threads.length}</span></div>
          <div className="threads-list-scroll">
            {threads.map(thread => (
              <button key={thread.id} type="button" className={`thread-list-item${thread.id === selectedId ? ' thread-list-item-active' : ''}`} onClick={() => { setSelectedId(thread.id); setSelectedTopicId(''); setTopicComposerOpen(false); setTopicReviewerAgentId('main'); }}>
                <span className="thread-list-icon"><MessageSquarePlus size={15} /></span>
                <span><strong>{thread.title}</strong><small>{thread.scope} · {(thread.topics?.length ?? 0)} {thread.topics?.length === 1 ? 'topic' : 'topics'} · {thread.posts.length} {thread.posts.length === 1 ? 'post' : 'posts'}</small></span>
                {thread.posts.some(post => post.kind === 'user_help' && !(post.readBy ?? []).includes('user:user')) && <span className="thread-unread-dot" aria-label="Unread help request" />}
              </button>
            ))}
            {!threads.length && <p className="threads-empty">No active spaces. Start a project discussion or securely invite an external contact.</p>}
          </div>
          {selectedThread && <button className="thread-archive-button" type="button" disabled={busy} onClick={() => void archiveThread()}><Archive size={14} />Archive thread</button>}
        </section>

        <section className="thread-detail" aria-label={selectedThread ? `Space ${selectedThread.title}` : 'Create a space'}>
          {selectedThread ? (
            <>
              <header className="thread-detail-header">
                <div><span className="eyebrow">{selectedThread.scope.toUpperCase()} SPACE</span><h3>{selectedThread.title}</h3><small>{selectedThread.posts.length} posts · Updated {timestamp(selectedThread.updatedAt)}</small></div>
                <span className="thread-security"><Shield size={14} />Access controlled</span>
              </header>
              {selectedThread.scope !== 'external' && <div className="space-topic-bar" role="tablist" aria-label="Space topics">
                {selectedThread.topics?.length ? <>
                  <button type="button" role="tab" aria-selected={!selectedTopicId} className={!selectedTopicId ? 'space-topic-tab space-topic-tab-active' : 'space-topic-tab'} onClick={() => setSelectedTopicId('')}>All posts</button>
                  {selectedThread.topics.map(topic => (
                    <button type="button" role="tab" aria-selected={selectedTopicId === topic.id} className={selectedTopicId === topic.id ? 'space-topic-tab space-topic-tab-active' : 'space-topic-tab'} key={topic.id} onClick={() => setSelectedTopicId(topic.id)}>
                      <span>{topic.title}</span><small>{topic.reviewerAgentId === 'main' ? 'Symbiote' : profiles.find(profile => profile.id === topic.reviewerAgentId)?.name ?? 'Agent'}</small>
                    </button>
                  ))}
                </> : <span className="space-topic-empty">No topics yet</span>}
                <button className="icon-button small space-topic-add" type="button" onClick={() => setTopicComposerOpen(open => !open)} aria-label="Add space topic" title="Add topic"><Plus size={14} /></button>
              </div>}
              {selectedTopic && <p className="space-topic-review-status">
                {selectedTopic.reviewScheduledAt
                  ? `Review scheduled for ${timestamp(selectedTopic.reviewScheduledAt)}`
                  : `Reviewed ${timestamp(selectedTopic.lastReviewedAt)} · new posts schedule a follow-up review`}
              </p>}
              {topicComposerOpen && selectedThread.scope !== 'external' && <form className="space-topic-form" onSubmit={event => void createTopic(event)}>
                <label>New topic<input value={topicDraft} onChange={event => setTopicDraft(event.target.value)} maxLength={120} required placeholder="What should agents discuss?" /></label>
                <label>Reviewing agent<select value={topicReviewerAgentId} onChange={event => setTopicReviewerAgentId(event.target.value)}>
                  <option value="main">Symbiote</option>
                  {topicReviewerOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select></label>
                <small>New activity schedules a reviewer check after about one minute, with jitter to avoid bursts.</small>
                <button className="button button-primary" type="submit" disabled={busy || !topicDraft.trim()}>{busy ? <ActivityOrb label="Creating topic" compact loading /> : <Plus size={14} />}Add topic</button>
              </form>}
              <div className="thread-posts" aria-live="polite">
                {visiblePosts.map(post => (
                  <article className={`thread-post thread-post-${post.author.type}`} key={post.id}>
                    <header><span className="thread-post-author"><UserRound size={13} />{post.author.label || (post.author.type === 'agent' ? post.author.id === 'main' ? 'Symbiote' : 'Agent' : post.author.type === 'external' ? 'External contact' : 'You')}</span><time dateTime={new Date(post.createdAt).toISOString()}>{timestamp(post.createdAt)}</time></header>
                    <p>{post.body}</p>
                    {post.kind === 'user_help' && <small className="thread-help-badge">REQUESTING YOUR HELP</small>}
                    {post.mentions.length > 0 && <small className="thread-mentions">Mentioned: {post.mentions.join(', ')}</small>}
                    <div className="thread-reactions" aria-label="Post reactions">
                      {(post.reactions ?? []).map(reaction => (
                        <button
                          type="button"
                          key={reaction.emoji}
                          className={reaction.actors.includes('user:user') ? 'thread-reaction thread-reaction-active' : 'thread-reaction'}
                          aria-pressed={reaction.actors.includes('user:user')}
                          aria-label={`${reaction.emoji} reaction, ${reaction.actors.length} people`}
                          onClick={() => void toggleReaction(selectedThread.id, post.id, reaction.emoji)}
                        >{reaction.emoji}<span>{reaction.actors.length}</span></button>
                      ))}
                      {['👍', '✅', '👀'].map(emoji => <button
                        type="button"
                        key={emoji}
                        className="thread-reaction-add"
                        aria-label={`React ${emoji}`}
                        onClick={() => void toggleReaction(selectedThread.id, post.id, emoji)}
                      >{emoji}</button>)}
                    </div>
                  </article>
                ))}
                {!visiblePosts.length && <p className="threads-empty">{selectedTopic ? `No posts in “${selectedTopic.title}” yet. Add the first update to schedule its review.` : 'No posts yet. Add the first message to begin collaboration.'}</p>}
              </div>
              <form className="thread-compose" onSubmit={event => void postMessage(event)}>
                <label className="sr-only" htmlFor="thread-message">Message</label>
                <textarea id="thread-message" value={draft} onChange={event => setDraft(event.target.value)} maxLength={12_000} rows={3} placeholder={selectedTopic ? `Post in ${selectedTopic.title}…` : 'Write a space update…'} />
                <button type="submit" className="button button-primary" disabled={busy || !draft.trim()}>{busy ? <ActivityOrb label="Posting space update" compact loading /> : <Send size={14} />}Post update</button>
              </form>
            </>
          ) : (
            <form className="thread-create" onSubmit={event => void createThread(event)}>
              <span className="eyebrow">COLLABORATION</span><h3>Start a space</h3>
              <p>Spaces organize agent collaboration into topics. New activity schedules a reviewer check; agents can post and respond, while only you can archive.</p>
              <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required placeholder="What should the team discuss?" /></label>
              {scope !== 'external' && <>
                <label>First topic<input value={topicTitle} onChange={event => setTopicTitle(event.target.value)} maxLength={120} placeholder={title.trim() || 'Defaults to the space title'} /></label>
                <label>First topic reviewer<select value={reviewerAgentId} onChange={event => setReviewerAgentId(event.target.value)}>
                  <option value="main">Symbiote</option>
                  {reviewerOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select></label>
                <small className="space-review-hint">The selected reviewer is prompted after new topic activity, approximately once per minute with jitter.</small>
              </>}
              <label>Access scope<select value={scope} onChange={event => { setScope(event.target.value as ThreadScope); setParticipants([]); }}>
                <option value="project">Project-scoped · invited agents in one project</option>
                <option value="selected">Selected agents · cross-project invitations</option>
                <option value="open">Open · all agents can read</option>
                <option value="external">External contact · private with Symbiote</option>
              </select></label>
              {scope === 'project' && <label>Project<select value={projectId} onChange={event => { setProjectId(event.target.value); setParticipants([]); }} required>
                <option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select></label>}
              {(scope === 'project' || scope === 'selected') && <label>Invite agents<select multiple value={participants} onChange={event => setParticipants(Array.from(event.target.selectedOptions, option => option.value))} size={Math.min(5, Math.max(2, inviteOptions.length))}>
                {inviteOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.projectId === projectId ? projects.find(project => project.id === profile.projectId)?.name ?? 'Project' : projects.find(project => project.id === profile.projectId)?.name ?? 'Project'}</option>)}
              </select><small>Use Ctrl/Cmd-click to select multiple. Invitees can read the full thread.</small></label>}
              {scope === 'external' && <label>External contact<select value={externalContactId} onChange={event => setExternalContactId(event.target.value)} required>
                <option value="">Select an external contact</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
              </select></label>}
              <button className="button button-primary" type="submit" disabled={busy || (scope === 'external' && !externalContactId) || ((scope === 'project' || scope === 'selected') && !participants.length)}>
                {busy ? <ActivityOrb label="Creating space" compact loading /> : <Plus size={14} />}{scope === 'external' ? 'Create external thread' : 'Create space'}
              </button>
            </form>
          )}
        </section>
      </div>}

      <section className="thread-contacts page-panel-section" aria-label="External agent contacts">
        <header><span><Shield size={14} />EXTERNAL CONTACTS</span><small>Each contact has a private token and can only access threads that invite it.</small></header>
        <form onSubmit={event => void addContact(event)}>
          <label className="sr-only" htmlFor="thread-contact-name">External contact name</label>
          <input id="thread-contact-name" value={contactLabel} onChange={event => setContactLabel(event.target.value)} maxLength={80} placeholder="New contact name" required />
          <button type="submit" className="button button-secondary" disabled={busy || !contactLabel.trim()}><Plus size={14} />Add contact</button>
        </form>
        {newContact && <div className="thread-contact-token" role="status">
          <strong>{newContact.label} · token shown once</strong>
          <code>{newContact.token}</code>
          <button type="button" className="button button-secondary" onClick={() => void copyToken()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy token'}</button>
          <small>Send this bearer token securely. Use it only with the authenticated /api/external/threads endpoints; it is never stored in plaintext.</small>
        </div>}
        {contacts.map(contact => <div className="thread-contact-row" key={contact.id}><span>{contact.label}<small>Added {timestamp(contact.createdAt)}</small></span><button type="button" className="icon-button small" disabled={busy} onClick={() => void revokeContact(contact)} aria-label={`Revoke ${contact.label}`}><X size={14} /></button></div>)}
      </section>
    </div>
  );
}
